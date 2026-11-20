import type { BatchHandler } from "../channels/pipeline.ts";
import type { InboundMessage } from "../imessage/types.ts";
import { type ContactResolver, normalizeHandle, sessionKeyFor } from "../sessions/key.ts";
import { log } from "../util/log.ts";
import { type GrokCaller, SHARED_CALLER, callerName } from "./caller.ts";
import { type Exchange, type ExchangeLog, describeExchange } from "./exchanges.ts";
import type { PendingOrigin } from "./pending.ts";
import { forVoice } from "./reply-text.ts";
import {
  GROK_REPORT_SERVICE,
  GROK_SERVICE,
  GROK_TELL_SERVICE,
  grokRowId,
  grokTurnOf,
} from "./session.ts";

/**
 * Turns a spoken request into a real Edmund turn and waits for the answer.
 *
 * The request goes into the person's ordinary iMessage DM session, as one more
 * inbound there (see `session.ts`). The pipeline gives no handle on a turn:
 * `enqueue` returns nothing, and the reply leaves through `deliverReply`. So the
 * relay watches both ends, and matches them by message guid. The wrapper from
 * `trackGrokTurns` says when a turn holding a request is over (`end`); a turn
 * that holds a request tells `deliverReply` so, and the deliverer registered
 * with `channels/deliver.ts` hands over the reply text while that request is
 * still waiting on the line (`capture`).
 *
 * That makes the decision per turn: a reply is captured only when the batch it
 * answers holds a waiting request. Turns for ordinary texts never reach the
 * relay at all.
 *
 * `tell` and `report` are the same inbound with nobody on the line (tell_edmund,
 * and a Grok Bot's report_to_edmund): they return at once, and the relay only
 * watches the turn so the reply it texted lands in the exchange log, where
 * check_edmund finds it.
 *
 * A request that runs past the timeout stops waiting but the turn does not stop:
 * its reply finds no one on the line, `capture` declines, and `deliverReply`
 * texts it to the person's iMessage DM instead. Nothing is cancelled and nothing
 * is lost. The same is true of a request that queued behind a turn already
 * running in the DM session: it may time out before its own turn even starts.
 */

type Kind = NonNullable<Exchange["kind"]>;

type Waiter = {
  /** "ask" waits on the line; "tell" and "report" never do. */
  kind: Kind;
  msgGuid: string;
  said: string;
  atMs: number;
  /** Who called, from the key they presented. */
  caller: GrokCaller;
  state: "waiting" | "abandoned" | "done";
  /** What the turn has said so far, for the line. */
  captured: string[];
  /** Replies that arrived after the line gave up (they were texted). */
  late: string[];
  resolve: (result: { ok: boolean }) => void;
};

export type GrokRelayOptions = {
  /** Whose Edmund this is. */
  handle: string;
  /** Canonicalises the handle exactly as an iMessage from them would be, so the
   *  request lands in the same DM session as their texts. */
  contacts: ContactResolver;
  /** The chat guid their DM session already uses, so a request never writes a
   *  synthetic one into the session row. Unknown falls back to the usual form. */
  chatGuidFor?: (sessionKey: string) => string | undefined;
  enqueue: (key: string, msg: InboundMessage) => void;
  exchanges: ExchangeLog;
  answerTimeoutMs: number;
  slowReply: string;
  maxReplyChars: number;
  now?: () => number;
};

const DONE_REPLY = "Done.";
/** How long a fire-and-forget entry may wait for its turn to finish. */
const STALE_MS = 2 * 60 * 60_000;
const SNAG_REPLY = "Edmund hit a snag on that one. Try again in a moment.";

export class GrokRelay {
  private waiters: Waiter[] = [];
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly opts: GrokRelayOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Run one spoken request and return what to say back. Never throws. */
  async ask(message: string, caller: GrokCaller = SHARED_CALLER): Promise<string> {
    const { waiter, settled } = this.submit("ask", message, message, caller);
    return this.awaitAnswer(waiter, settled);
  }

  /**
   * Fire and forget: queue the message as a turn and return. Nothing waits for
   * the reply; it is texted to the person's DM like any other, and logged.
   */
  tell(message: string, caller: GrokCaller = SHARED_CALLER): void {
    this.submit("tell", message, message, caller);
  }

  /**
   * A Grok Bot finished a task Edmund gave it. Wakes him with an inbound that
   * says so; the reply is texted. `text` is the whole inbound (built by the
   * caller, who knows the task), `said` is the short audit line, and `caller` is
   * whoever presented the key the report arrived on.
   *
   * Where he wakes is where the task was asked from (`origin`): the group chat
   * if it was handed over there, otherwise the owner's DM. A task recorded
   * without an origin, or with one that no longer maps to a session this relay
   * can build, wakes the DM, as every report once did.
   */
  report(
    text: string,
    said: string,
    caller: GrokCaller = SHARED_CALLER,
    origin?: PendingOrigin,
  ): void {
    this.submit("report", said, text, caller, origin);
  }

  private submit(
    kind: Kind,
    said: string,
    text: string,
    caller: GrokCaller,
    origin?: PendingOrigin,
  ): { waiter: Waiter; settled: Promise<{ ok: boolean }> } {
    const atMs = this.now();
    const n = this.seq++;
    this.sweep(atMs);
    let resolve!: Waiter["resolve"];
    const settled = new Promise<{ ok: boolean }>((r) => {
      resolve = r;
    });
    const waiter: Waiter = {
      kind,
      msgGuid: `grok-${kind === "ask" ? "" : `${kind}-`}${atMs}-${n}`,
      said,
      atMs,
      caller,
      state: "waiting",
      captured: [],
      late: [],
      resolve,
    };
    this.waiters.push(waiter);

    const { handle, contacts } = this.opts;
    const service =
      kind === "ask" ? GROK_SERVICE : kind === "tell" ? GROK_TELL_SERVICE : GROK_REPORT_SERVICE;
    const group = origin?.isGroup ? this.groupInbound(origin) : null;
    if (group) {
      // The same key a text typed in that group gets, so the wake-up joins that
      // conversation, and the reply (to: chatGuid, isGroup) is delivered to the group.
      const msg: InboundMessage = {
        rowId: grokRowId(atMs),
        msgGuid: waiter.msgGuid,
        chatIdentifier: group.chatIdentifier,
        chatGuid: group.chatGuid,
        isGroup: true,
        fromHandle: handle,
        fromMe: false,
        text,
        timestampMs: atMs,
        attachments: [],
        attachmentTranscripts: {},
        service,
        replyToGuid: null,
        grokCaller: caller,
      };
      this.opts.enqueue(group.key, msg);
      return { waiter, settled };
    }
    const msg: InboundMessage = {
      rowId: grokRowId(atMs),
      msgGuid: waiter.msgGuid,
      chatIdentifier: handle,
      chatGuid: "",
      isGroup: false,
      fromHandle: handle,
      fromMe: false,
      text,
      timestampMs: atMs,
      attachments: [],
      attachmentTranscripts: {},
      service,
      replyToGuid: null,
      grokCaller: caller,
    };
    // The same key an iMessage from this person gets: one conversation.
    const key = sessionKeyFor(msg, contacts);
    msg.chatGuid = this.opts.chatGuidFor?.(key) || `any;-;${normalizeHandle(handle)}`;
    this.opts.enqueue(key, msg);
    return { waiter, settled };
  }

  /**
   * The group session a report belongs to, or null to use the owner's DM. Only a
   * main-persona iMessage group is built (`imessage:group:<chatGuid>`, what
   * `sessionKeyFor` makes of a group inbound); the key it yields must be the
   * recorded one, so a wake-up can never land in a session nobody asked from.
   */
  private groupInbound(
    origin: PendingOrigin,
  ): { key: string; chatGuid: string; chatIdentifier: string } | null {
    const chatGuid = origin.chatGuid.trim();
    if (!chatGuid) return null;
    // chat.db's chat_identifier is the last part of the guid ("any;+;chat123" -> "chat123").
    const chatIdentifier = chatGuid.slice(chatGuid.lastIndexOf(";") + 1) || chatGuid;
    const probe = { isGroup: true, chatGuid, chatIdentifier, fromHandle: this.opts.handle };
    const key = sessionKeyFor(probe as InboundMessage, this.opts.contacts);
    if (key !== origin.sessionKey || !key.startsWith("imessage:group:")) {
      log.warn("grok", "report origin does not map to its group session; waking the DM", {
        origin: origin.sessionKey,
      });
      return null;
    }
    return { key, chatGuid, chatIdentifier };
  }

  /** Forget fire-and-forget entries whose turn never reported back (a restart
   *  mid-flight, a dropped batch), so the list cannot grow without bound. */
  private sweep(nowMs: number): void {
    this.waiters = this.waiters.filter((w) => w.kind === "ask" || nowMs - w.atMs < STALE_MS);
  }

  private async awaitAnswer(waiter: Waiter, settled: Promise<{ ok: boolean }>): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      settled,
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), this.opts.answerTimeoutMs);
      }),
    ]);
    clearTimeout(timer);

    if (outcome === "timeout") return this.giveUp(waiter);
    return this.answer(waiter, outcome.ok);
  }

  /**
   * The model produced reply text for a turn whose batch holds these requests.
   * `spoken` is true when one of them is still waiting for it, so it goes back
   * on the line. `textToo` is true when a request in the same batch had already
   * given up and was promised a text: that reply must reach iMessage as well
   * (with nobody left on the line it does so anyway, as an ordinary text; see
   * `deliverReply`).
   */
  capture(text: string, msgGuids: readonly string[]): { spoken: boolean; textToo: boolean } {
    const mine = this.waiters.filter((w) => msgGuids.includes(w.msgGuid));
    const live = mine.filter((w) => w.kind === "ask" && w.state === "waiting");
    const gone = mine.filter((w) => w.kind === "ask" && w.state === "abandoned");
    const queued = mine.filter((w) => w.kind !== "ask");
    // Requests batched into one turn share its single reply.
    for (const w of live) w.captured.push(text);
    for (const w of gone) w.late.push(text);
    // A tell or report has no line: its reply is always a text, and kept for the log.
    for (const w of queued) w.captured.push(text);
    return { spoken: live.length > 0, textToo: gone.length > 0 || queued.length > 0 };
  }

  /** A turn holding these requests finished, cleanly or not. */
  end(msgGuids: readonly string[], ok: boolean): void {
    for (const w of this.waiters.filter((x) => msgGuids.includes(x.msgGuid))) {
      if (w.kind !== "ask") {
        this.record(w, takeCaptured(w), "texted");
        this.forget(w);
      } else if (w.state === "waiting") {
        w.state = "done";
        w.resolve({ ok });
      } else if (w.state === "abandoned") {
        this.record(w, w.late.join(" "), "texted");
        this.forget(w);
      }
    }
  }

  private answer(w: Waiter, ok: boolean): string {
    const said = takeCaptured(w);
    this.record(w, said, "spoken");
    this.forget(w);
    if (!ok && !said) return SNAG_REPLY;
    return said ? forVoice(said, this.opts.maxReplyChars) : DONE_REPLY;
  }

  /** The line timed out. A reply that landed a moment ago still beats "working on it". */
  private giveUp(w: Waiter): string {
    w.state = "abandoned";
    const said = takeCaptured(w);
    if (said) {
      this.record(w, said, "spoken");
      this.forget(w);
      return forVoice(said, this.opts.maxReplyChars);
    }
    log.info("grok", "answer timed out; the reply will be texted", {
      caller: callerName(w.caller),
      waitedMs: this.now() - w.atMs,
    });
    return this.opts.slowReply;
  }

  private forget(w: Waiter): void {
    this.waiters = this.waiters.filter((x) => x !== w);
  }

  private record(w: Waiter, reply: string, via: "spoken" | "texted"): void {
    const entry: Exchange = {
      atMs: w.atMs,
      handle: this.opts.handle,
      said: w.said,
      reply,
      via,
      ...(w.kind === "ask" ? {} : { kind: w.kind }),
      caller: w.caller,
    };
    try {
      this.opts.exchanges.record(entry);
    } catch (err) {
      log.warn("grok", "could not log exchange", { err: String(err) });
    }
    log.info("grok", `exchange (${via})`, {
      caller: callerName(w.caller),
      text: describeExchange(entry).slice(0, 300),
    });
  }
}

function takeCaptured(w: Waiter): string {
  const text = w.captured.join(" ").trim();
  w.captured = [];
  return text;
}

/**
 * Wrap the pipeline's batch handler so the relay learns when a turn holding a
 * Grok request ends. Decided per batch: any turn without one, in any session,
 * passes straight through. `getRelay` is late-bound because the pipeline is
 * built before the channel that owns the relay.
 */
export function trackGrokTurns(
  handler: BatchHandler,
  getRelay: () => GrokRelay | null,
): BatchHandler {
  return async (key, batch) => {
    const guids = grokTurnOf(batch)?.msgGuids ?? [];
    const relay = guids.length > 0 ? getRelay() : null;
    if (!relay) return handler(key, batch);
    let ok = false;
    try {
      await handler(key, batch);
      ok = true;
    } finally {
      relay.end(guids, ok);
    }
  };
}
