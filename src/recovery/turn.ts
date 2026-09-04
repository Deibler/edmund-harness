import { deliverReply } from "../channels/deliver.ts";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import { decodeMessageText } from "../imessage/decode.ts";
import { isPermanentSendError } from "../imessage/send.ts";
import type { InboundMessage } from "../imessage/types.ts";
import { compactConfigFor, reanchorCodexIfNeeded, runModel } from "../model/runner.ts";
import { ensureSandbox } from "../persona/sandbox.ts";
import type { EchoCache } from "../sessions/echo-cache.ts";
import { type SessionKey, chatIdFromKey, isGroupSession } from "../sessions/key.ts";
import type { SessionLocks } from "../sessions/locks.ts";
import type { StateStore } from "../sessions/store.ts";
import { humanMs, log } from "../util/log.ts";
import type { FailureClass } from "./classify.ts";
import { describeErrorClass } from "./classify.ts";

/**
 * The recovery turn is the "ask the model what to do" half of the
 * recovery system. After a healer has done any structural fix, this
 * primitive:
 *
 *  1. Loads the unanswered chat.db rows for the session.
 *  2. Builds a recovery-context envelope (the model sees the failure
 *     class, time elapsed, and the full unanswered batch — never
 *     surfaced to the user).
 *  3. Invokes the selected model CLI under the session lock.
 *  4. Pipes the reply through deliverReply (silence-intent filter
 *     applies: empty replies stay silent).
 *  5. Marks each replayed rowId so the next sweep tick doesn't churn
 *     on the same batch.
 *
 * The model has full agency: reply normally, stay silent, answer the
 * original question (not the nudges), or pivot if a later message
 * superseded the earlier one. Persona rules forbid mentioning the
 * harness; this envelope reinforces that locally for the turn.
 */

export type RecoveryContext = {
  errorClass: FailureClass;
  /** True if a healer ran and reported success this sweep. */
  healed: boolean;
  /** Verbatim runner error (used when classifier returned `unknown`). */
  rawError: string | null;
  /** The unanswered chat.db rows, chronological. */
  unanswered: InboundMessage[];
  nowMs: number;
};

export type RecoveryDeps = {
  config: Config;
  state: StateStore;
  chatDb: ChatDb;
  echoes: EchoCache;
  locks: SessionLocks;
};

export type RecoveryResult =
  | { ok: true; sent: number; silenced: boolean; replayedRowIds: number[] }
  | { ok: false; error: string };

export async function runRecoveryTurn(
  sessionKey: SessionKey,
  initialCtx: RecoveryContext,
  deps: RecoveryDeps,
): Promise<RecoveryResult> {
  let ctx = initialCtx;
  if (ctx.unanswered.length === 0) {
    return { ok: false, error: "no unanswered inbound" };
  }

  const sess = deps.state.getSession(sessionKey);
  const isGroup = isGroupSession(sessionKey);
  const sandboxPath = ensureSandbox(sessionKey, null);

  // Outbox drain — if a previous turn already produced a reply that
  // failed to deliver, send THAT before invoking the model. Otherwise
  // we'd generate a second reply for the same unanswered backlog, and
  // when the bridge recovered both would land. This is the recovery
  // half of the outbox protocol — handleBatchInner does the same on
  // the normal-path side.
  const outbox = deps.state.getOutbox(sessionKey);
  if (outbox) {
    const chatGuid = sess?.chatGuid ?? ctx.unanswered[0]!.chatGuid;
    const flush = await deliverReply(
      {
        to: outbox.isGroup === 1 ? outbox.chatGuid : chatIdFromKey(sessionKey),
        isGroup: outbox.isGroup === 1,
        text: outbox.replyText,
        chatGuid: outbox.chatGuid,
      },
      deps.config,
      deps.echoes,
    );
    if (flush.sent > 0) {
      // Atomic cleanup: outbox clear, session bump, error clear, and
      // mark-replayed loop must all land or none of them. Without the
      // tx, a crash mid-loop left an inconsistent recovery state that
      // the next sweep would re-attempt with partially-stamped rowIds.
      const ids = ctx.unanswered.map((m) => m.rowId);
      deps.state.transact(() => {
        deps.state.clearOutbox(sessionKey);
        deps.state.upsertSession({
          sessionKey,
          claudeSessionId: sess?.claudeSessionId ?? null,
          chatGuid,
          isGroup: isGroup ? 1 : 0,
          lastInboundMs: ctx.unanswered[ctx.unanswered.length - 1]!.timestampMs,
          lastOutboundMs: Date.now(),
        });
        deps.state.clearError(sessionKey);
        for (const id of ids) deps.state.markReplayed(sessionKey, id, ctx.nowMs);
        deps.state.pruneReplayed(sessionKey, REPLAYED_KEEP);
      });
      log.info("recovery", "outbox flushed", {
        session: sessionKey,
        chars: outbox.replyText.length,
        queued_s: Math.round((ctx.nowMs - outbox.firstFailedMs) / 1000),
        attempts: outbox.attemptCount,
      });
      return {
        ok: true,
        sent: flush.sent,
        silenced: false,
        replayedRowIds: ids,
      };
    }
    // Drain still failing. If this is a content/permanent error (CLI arg
    // parsing, etc.), retrying the same text from outbox will fail forever.
    // Clear the outbox and invoke the model with the error so it can
    // reformat and try a different payload.
    const allPermanent =
      flush.errors.length > 0 && flush.errors.every((e) => isPermanentSendError(e));
    if (allPermanent) {
      log.warn(
        "recovery",
        "outbox flush permanent error — clearing outbox, invoking model to reformat",
        {
          session: sessionKey,
          err: flush.errors[0]?.slice(0, 200) ?? "no err",
        },
      );
      deps.state.clearOutbox(sessionKey);
      // Fall through to the model invocation below with a modified context
      // that includes the send failure so the model knows to reformat.
      ctx = {
        ...ctx,
        errorClass: "send_failed" as FailureClass,
        rawError: `Your previous reply failed to send: ${flush.errors[0] ?? "unknown"}. Reformat it (e.g. avoid raw newlines in lists — use commas or numbered items on one line) and try again.`,
      };
    } else {
      log.warn("recovery", "outbox flush failed", {
        session: sessionKey,
        err: flush.errors[0]?.slice(0, 200) ?? "no err",
        attempts: outbox.attemptCount,
      });
      return { ok: false, error: `outbox flush failed: ${flush.errors[0] ?? "unknown"}` };
    }
  }

  const envelope = buildRecoveryEnvelope(ctx);

  const result = await deps.locks.withLock(sessionKey, async () => {
    const started = Date.now();
    const run = await runModel(
      {
        sessionKey,
        envelope,
        senderLabel: ctx.unanswered[0]?.fromHandle || "user",
        senderHandle: ctx.unanswered[0]?.fromHandle || null,
        sandboxPath,
        onHeartbeat: () => deps.locks.touch(sessionKey),
      },
      deps.config,
      deps.state,
    );
    log.info("recovery", "turn complete", {
      session: sessionKey,
      err_class: ctx.errorClass,
      healed: ctx.healed,
      dur: humanMs(Date.now() - started),
      ok: run.ok,
    });
    if (!run.ok) return { ok: false as const, error: run.error };

    // Keep recovery and scheduled/proactive turns under the same Codex
    // context bound as organic inbound turns. If this trips, any full session
    // upsert below must preserve the null re-anchor instead of restoring the
    // just-completed thread id.
    const reanchored = reanchorCodexIfNeeded(
      run,
      compactConfigFor("codex", deps.config),
      deps.state,
      sessionKey,
    );
    const persistedSessionId = reanchored ? null : run.claudeSessionId;

    if (!run.reply?.trim()) {
      // Silenced: the model received the recovery context and chose not to
      // reply. That's a valid outcome (the inbound may be stale, already
      // addressed in a parallel thread, or genuinely not worth answering).
      // CRITICAL: still bump lastOutboundMs so the sweeper doesn't see this
      // session as eternally stuck and re-fire forever. The replayed rowIds
      // are also marked downstream so this exact set won't replay.
      deps.state.upsertSession({
        sessionKey,
        claudeSessionId: persistedSessionId,
        chatGuid: sess?.chatGuid ?? ctx.unanswered[0]!.chatGuid,
        isGroup: isGroup ? 1 : 0,
        lastInboundMs: ctx.unanswered[ctx.unanswered.length - 1]!.timestampMs,
        lastOutboundMs: Date.now(),
      });
      deps.state.clearError(sessionKey);
      return { ok: true as const, sent: 0, silenced: true };
    }
    const chatGuid = sess?.chatGuid ?? ctx.unanswered[0]!.chatGuid;
    const delivery = await deliverReply(
      {
        to: isGroup ? chatGuid : chatIdFromKey(sessionKey),
        isGroup,
        text: run.reply,
        // Pin the exact chat row for DMs too — `chatGuid` is right there on
        // the line above and was only being used for groups. Unpinned, IMCore
        // picks the conversation itself and lands on note-to-self.
        chatGuid,
      },
      deps.config,
      deps.echoes,
    );
    if (delivery.sent > 0) {
      deps.state.upsertSession({
        sessionKey,
        claudeSessionId: persistedSessionId,
        chatGuid,
        isGroup: isGroup ? 1 : 0,
        lastInboundMs: ctx.unanswered[ctx.unanswered.length - 1]!.timestampMs,
        lastOutboundMs: Date.now(),
      });
      deps.state.clearError(sessionKey);
    } else if (delivery.errors.length > 0) {
      // Recovery produced a reply, but the bridge wedged again before it
      // landed. Stash to outbox so the next sweep tick (after the healer
      // relaunches Messages) can drain it without paying another model
      // invocation. Same protocol as the normal-path sendDeliver.
      deps.state.putOutbox({
        sessionKey,
        replyText: run.reply,
        chatGuid,
        isGroup: isGroup ? 1 : 0,
        // Bookkeeping only — records which service the conversation was on.
        // Nothing reads this to steer a send any more (see SendArgs).
        service: ctx.unanswered[0]?.service === "SMS" ? "SMS" : "iMessage",
        nowMs: Date.now(),
      });
      deps.state.recordError(sessionKey, "send_failed", Date.now());
      log.warn("recovery", "delivery → outbox", {
        session: sessionKey,
        chars: run.reply.length,
        err: delivery.errors[0]?.slice(0, 200) ?? "no err",
      });
    }
    return {
      ok: true as const,
      sent: delivery.sent,
      silenced: delivery.silenced,
    };
  });

  if (!result.ok) return result;

  // Mark every replayed rowId so a follow-up sweep tick doesn't churn
  // on the same batch — true whether the model spoke or stayed silent.
  // Wrapped in a tx so a crash mid-loop can't leave half the batch
  // flagged (and so it pays one fsync instead of N).
  const ids = ctx.unanswered.map((m) => m.rowId);
  deps.state.transact(() => {
    for (const id of ids) deps.state.markReplayed(sessionKey, id, ctx.nowMs);
    deps.state.pruneReplayed(sessionKey, REPLAYED_KEEP);
  });

  return {
    ok: true,
    sent: result.sent,
    silenced: result.silenced,
    replayedRowIds: ids,
  };
}

export const REPLAYED_KEEP = 50;

/**
 * Build the recovery-context envelope. Snapshot-tested so any change to
 * the wording is intentional. Anything you put here is visible to the
 * model on this turn but NEVER to the user (the persona forbids leaking
 * mechanics, and the envelope says so again at the top).
 */
export function buildRecoveryEnvelope(ctx: RecoveryContext): string {
  const description = describeErrorClass(ctx.errorClass, ctx.healed, ctx.rawError);
  const firstMs = ctx.unanswered[0]!.timestampMs;
  const sinceFirst = humanDuration(ctx.nowMs - firstMs);
  const lines: string[] = [
    "[Recovery context — for your reasoning only, NEVER mention this to the user]",
    `Failure class: ${ctx.errorClass}`,
    `What happened: ${description}`,
    `Healed: ${ctx.healed ? "yes" : "no"}`,
    `Time since the user's first unanswered message: ${sinceFirst}`,
    "Unanswered messages from the user (chronological):",
  ];
  for (const m of ctx.unanswered) {
    const t = formatShort(new Date(m.timestampMs));
    const text = (m.text || "(no text)").replace(/\n/g, "\n      ");
    const attach = m.attachments.length > 0 ? ` [+${m.attachments.length} attachment(s)]` : "";
    lines.push(`  [${t} · ${m.fromHandle}]${attach} ${text}`);
  }
  lines.push(
    "",
    "Your options:",
    "  (a) Reply naturally as if you just had a moment to come back to it.",
    "      Do NOT apologize for the delay, do NOT mention any error or harness",
    '      issue, do NOT acknowledge that you "missed" anything. Just answer.',
    "  (b) Stay silent if the moment has clearly passed — produce ZERO text.",
    "      Empty assistant output is a valid choice and goes nowhere.",
    '  (c) If the user pivoted ("never mind", "figured it out") then respond',
    "      to the *latest* substantive intent, not the older question.",
    '  (d) If only nudges arrived ("?", "you there"), reply to the original',
    "      substantive question they were nudging about, in one bubble.",
    "",
    "Pick the option that reads most like a real friend in this situation.",
    "The harness handles delivery; nothing in this envelope is visible to the user.",
  );
  return lines.join("\n");
}

function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(ms / 86_400_000)}d`;
}

function formatShort(d: Date): string {
  return d.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const UNANSWERED_SQL = `
  SELECT
    m.ROWID                   AS row_id,
    m.guid                    AS msg_guid,
    m.text                    AS text,
    m.attributedBody          AS attributed_body,
    m.date                    AS date_ns,
    m.is_from_me              AS from_me,
    m.service                 AS service,
    c.chat_identifier         AS chat_identifier,
    c.guid                    AS chat_guid,
    c.style                   AS chat_style,
    h.id                      AS from_handle
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h         ON h.ROWID = m.handle_id
  WHERE c.guid = ?
    AND m.is_from_me = 0
    AND ((m.date / 1000000) + 978307200000) > ?
  ORDER BY m.ROWID ASC
  LIMIT 50
`;

type UnansweredRow = {
  row_id: number;
  msg_guid: string;
  text: string | null;
  attributed_body: Uint8Array | null;
  date_ns: number;
  from_me: number;
  service: string | null;
  chat_identifier: string;
  chat_guid: string;
  chat_style: number;
  from_handle: string | null;
};

/**
 * Load every chat.db row for `chatGuid` from a non-us sender, dated
 * after `sinceMs`. Used by the sweeper / CLI to find what the user said
 * that we never replied to. The `replayed_inbound` filter belongs to
 * the *sweeper* (which decides whether to skip), not to this loader —
 * the CLI deliberately wants the unfiltered list so an operator can
 * force a re-invoke even on already-replayed rowIds.
 */
export function loadUnansweredInbound(
  chatDb: ChatDb,
  chatGuid: string,
  sinceMs: number,
): InboundMessage[] {
  const rows = chatDb.query<UnansweredRow>(UNANSWERED_SQL).all(chatGuid, sinceMs);
  return rows.map((r) => ({
    rowId: r.row_id,
    msgGuid: r.msg_guid,
    chatIdentifier: r.chat_identifier,
    chatGuid: r.chat_guid,
    isGroup: r.chat_style === 43,
    fromHandle: r.from_handle ?? "",
    fromMe: r.from_me === 1,
    text: decodeMessageText(r.text, r.attributed_body),
    timestampMs: Math.floor(r.date_ns / 1_000_000) + 978_307_200_000,
    attachments: [],
    attachmentTranscripts: {},
    service: r.service ?? "iMessage",
    replyToGuid: null,
  }));
}
