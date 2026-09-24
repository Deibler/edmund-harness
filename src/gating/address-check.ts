import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import { getRecentMessages } from "../imessage/history.ts";
import { lookupReplyContext } from "../imessage/reply-lookup.ts";
import type { InboundMessage, UnnamedWake } from "../imessage/types.ts";
import { type JevQuestion, askJev } from "../jev/client.ts";
import { log } from "../util/log.ts";
import { gateInbound } from "./allowlist.ts";

/**
 * The missed-name check for groups. A group message that doesn't say the
 * assistant's name is dropped by the gate, yet some are plainly for him: a
 * follow-up in a conversation he is in, a swipe-reply to his message, his
 * name misspelled. Code picks those candidates; Jev decides whether each one
 * is for him; the assistant, once woken, decides whether to answer.
 *
 * Measured 2026-09-24 over 90 days of group traffic: 32 times a sender had to
 * point at an ignored message with a bare "<name>^", 31 of them within five
 * minutes of the assistant speaking.
 */

/** Bump when the questions, criteria or state shape change: scores shift with wording. */
export const ADDRESS_QUESTIONS_VERSION = "2026-09-24.1";

export type CandidateReason = UnnamedWake["reason"];

export type AddressDecision = {
  reason: CandidateReason;
  wake: boolean;
  /** The message marked un-named, when he should be woken now: mode "on",
   *  a wake decision, and under the day's cap. */
  woken?: InboundMessage & { unnamedWake: UnnamedWake };
  /** Probability of yes for each question. Absent when Jev gave no answer. */
  scores?: { addressed: number; wants_reply: number };
  error?: string;
};

export function assistantName(config: Config): string {
  const n = config.identity.names[0] ?? "assistant";
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export function addressQuestions(name: string): Record<string, JevQuestion> {
  return {
    addressed: {
      type: "noul",
      instructions: `Is \`latestMessage\` said to ${name}?`,
      criteria: {
        true: {
          what: `The sender is talking to ${name}: asking him something, answering or arguing with something he said, giving him instructions or information for a task he is doing, or reacting to him directly. His name may be missing or misspelled.`,
          examples: [
            "(right after he asked for a budget) I'm thinking 600 or cheaper",
            "(after his report) Also I count 21 teams, not 22",
            "OK, go ahead and tell one or two jokes",
          ],
        },
        false: {
          what: `The sender is talking to other people in the chat, or to nobody in particular: banter, reactions, plans between friends, or talking ABOUT ${name} rather than to him.`,
          examples: [
            "(to a friend) Are you at the bar?",
            "Haha no way",
            `Every update makes ${name} weirder`,
          ],
        },
      },
    },
    wants_reply: {
      type: "noul",
      instructions: `Does the sender of \`latestMessage\` expect or want ${name} to reply to it or act on it?`,
      criteria: {
        true: `The sender is waiting for ${name} to answer, do something, or respond.`,
        false: `No reply from ${name} is expected: the message is for someone else, or it is a thanks, laugh or reaction that needs no answer.`,
      },
    },
  };
}

/** Optimal string alignment distance (Levenshtein plus adjacent transpositions). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * A word within two edits of one of the assistant's names ("Edmudn", "edmun",
 * "Eemund"). Only names of five or more letters: two edits from a short name
 * like "ed" match half the dictionary. This only nominates a candidate; Jev
 * decides whether the word was meant as his name.
 */
export function nameLikeWord(text: string, names: string[]): string | null {
  const long = names.map((n) => n.toLowerCase()).filter((n) => n.length >= 5);
  for (const w of text.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    if (long.some((n) => editDistance(w, n) <= 2)) return w;
  }
  return null;
}

/** Unix ms of the assistant's last message in this chat before `beforeRowId`, or null. */
export function lastAssistantMs(
  chatDb: ChatDb,
  chatGuid: string,
  beforeRowId: number,
): number | null {
  const row = chatDb
    .query<{ date_ns: number | null }>(
      `SELECT MAX(m.date) AS date_ns
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE c.guid = ? AND m.is_from_me = 1 AND m.ROWID < ?`,
    )
    .get(chatGuid, beforeRowId);
  return row?.date_ns ? Math.floor(row.date_ns / 1_000_000) + 978_307_200_000 : null;
}

/**
 * Why this un-named group message is worth asking Jev about, or null when it
 * isn't. The caller has already established that the gate rejected it for
 * not naming the assistant in a registered group.
 */
export function candidateReason(
  msg: InboundMessage,
  chatDb: ChatDb,
  config: Config,
): CandidateReason | null {
  if (!msg.isGroup || msg.fromMe || !msg.text.trim()) return null;
  if (msg.replyToGuid && lookupReplyContext(chatDb, msg.replyToGuid)?.fromMe)
    return "reply-to-assistant";
  if (nameLikeWord(msg.text, config.identity.names)) return "name-like";
  const last = lastAssistantMs(chatDb, msg.chatGuid, msg.rowId);
  const windowMs = config.group_addressing.window_minutes * 60_000;
  if (last !== null && msg.timestampMs - last <= windowMs) return "after-assistant";
  return null;
}

/**
 * Jev's view of the moment: the last eight messages as objects, the new one in
 * its own field, and the parent when it is a swipe-reply. Senders become
 * "Person A", "Person B"; handles never leave the Mac.
 */
export function addressState(
  msg: InboundMessage,
  chatDb: ChatDb,
  config: Config,
): Record<string, unknown> {
  const name = assistantName(config);
  const alias = new Map<string, string>();
  const who = (handle: string, fromMe: boolean) => {
    if (fromMe) return name;
    if (!alias.has(handle))
      alias.set(handle, `Person ${String.fromCharCode(65 + (alias.size % 26))}`);
    return alias.get(handle)!;
  };
  const recent = getRecentMessages(chatDb, msg.chatGuid, msg.rowId, 16)
    .filter((l) => !l.isTapback)
    .slice(-8);
  const sender = who(msg.fromHandle, false);
  const parent = msg.replyToGuid ? lookupReplyContext(chatDb, msg.replyToGuid) : null;
  const last = lastAssistantMs(chatDb, msg.chatGuid, msg.rowId);
  return {
    assistant: {
      name,
      alsoCalled: config.identity.names.filter((n) => n.toLowerCase() !== name.toLowerCase()),
      description: `An AI assistant who is a member of this iMessage group chat. People talk to him by saying his name, but sometimes forget it or misspell it.`,
    },
    recentMessages: recent.map((l) => ({
      from: who(l.fromHandle, l.fromMe),
      secondsAgo: Math.max(0, Math.round((msg.timestampMs - l.timestampMs) / 1000)),
      text: l.text.slice(0, 400),
    })),
    latestMessage: {
      from: sender,
      text: msg.text.slice(0, 600),
      ...(parent
        ? {
            repliesTo: {
              from: who(parent.fromHandle, parent.fromMe),
              text: parent.text.slice(0, 400),
            },
          }
        : {}),
    },
    secondsSinceAssistantSpoke:
      last === null ? null : Math.max(0, Math.round((msg.timestampMs - last) / 1000)),
  };
}

/**
 * Wake on "wants a reply". A misspelled name or a swipe-reply to him is already
 * aimed his way, so for those "said to him" is enough: he decides whether a
 * thanks or a laugh needs an answer.
 */
export function shouldWake(
  reason: CandidateReason,
  scores: { addressed: number; wants_reply: number },
  config: Config,
): boolean {
  const c = config.group_addressing;
  if (scores.wants_reply >= c.reply_threshold) return true;
  return reason !== "after-assistant" && scores.addressed >= c.addressed_threshold;
}

export type AddressCheckerOptions = {
  config: Config;
  chatDb: ChatDb;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Runs the check off the inbound path: the watcher has already moved on when
 * the answer arrives. Every decision is appended to data/addressing.jsonl
 * (row id, scores, question version — never the text, which chat.db holds) so
 * thresholds can be recalibrated against what people did next.
 */
export class AddressChecker {
  private wakesToday = new Map<string, number>();

  constructor(private o: AddressCheckerOptions) {}

  private get cfg() {
    return this.o.config.group_addressing;
  }

  /**
   * Why `msg` should be checked, or null. Only a message the gate turned away
   * for not naming the assistant can be a candidate: one from an unregistered
   * group, from him, or refused for any other reason stays refused whatever
   * Jev would say. Uses the plain gate, never shouldAccept, which records
   * guest attempts as a side effect.
   */
  nominate(msg: InboundMessage): CandidateReason | null {
    if (this.cfg.mode === "off") return null;
    const gate = gateInbound(msg, this.o.config);
    if (gate.allow || gate.reason !== "not-mentioned") return null;
    try {
      return candidateReason(msg, this.o.chatDb, this.o.config);
    } catch (err) {
      log.warn("addressing", "could not read chat.db for a candidate", {
        row: msg.rowId,
        err: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * The live watcher's entry: check a candidate in the background and hand a
   * message to wake him to `route`. Null when `msg` isn't a candidate. The
   * promise never rejects, so the inbound path can drop it.
   */
  consider(
    msg: InboundMessage,
    route: (msg: InboundMessage) => void,
  ): Promise<AddressDecision> | null {
    const reason = this.nominate(msg);
    if (!reason) return null;
    return this.check(msg, reason).then((d) => {
      if (d.woken) {
        try {
          route(d.woken);
        } catch (err) {
          log.warn("addressing", "could not hand over a woken message", {
            row: msg.rowId,
            err: (err as Error).message,
          });
        }
      }
      return d;
    });
  }

  /**
   * Boot catch-up's entry: the backlog is read at once and coalesced into one
   * turn per chat, so a woken message joins its chat's batch instead of being
   * routed on its own. Resolves to the marked message, or null.
   */
  async admit(
    msg: InboundMessage,
  ): Promise<(InboundMessage & { unnamedWake: UnnamedWake }) | null> {
    const reason = this.nominate(msg);
    if (!reason) return null;
    return (await this.check(msg, reason)).woken ?? null;
  }

  async check(msg: InboundMessage, reason: CandidateReason): Promise<AddressDecision> {
    const now = this.o.now ?? Date.now;
    let decision: AddressDecision;
    let attempts: string[] = [];
    try {
      const state = addressState(msg, this.o.chatDb, this.o.config);
      const res = await askJev(state, addressQuestions(assistantName(this.o.config)), {
        apiKey: this.o.config.keys.openrouter,
        model: this.cfg.model,
        fetch: this.o.fetch,
        sleep: this.o.sleep,
      });
      attempts = res.attempts;
      const scores = {
        addressed: Number(res.answers.addressed),
        wants_reply: Number(res.answers.wants_reply),
      };
      decision = { reason, scores, wake: shouldWake(reason, scores, this.o.config) };
    } catch (err) {
      // No answer means no wake: the message is dropped, as it was before this check.
      decision = { reason, wake: false, error: (err as Error).message };
    }

    const day = new Date(now()).toISOString().slice(0, 10);
    const capKey = `${msg.chatGuid}|${day}`;
    let capped = false;
    if (decision.wake && this.cfg.mode === "on") {
      const n = this.wakesToday.get(capKey) ?? 0;
      if (n >= this.cfg.max_wakes_per_group_per_day) capped = true;
      else this.wakesToday.set(capKey, n + 1);
    }

    this.record(msg, decision, capped, attempts, now());
    if (decision.wake && this.cfg.mode === "on" && !capped && decision.scores) {
      decision.woken = {
        ...msg,
        unnamedWake: {
          reason,
          addressed: decision.scores.addressed,
          wantsReply: decision.scores.wants_reply,
        },
      };
    }
    return decision;
  }

  private record(
    msg: InboundMessage,
    d: AddressDecision,
    capped: boolean,
    attempts: string[],
    at: number,
  ): void {
    const what = d.error
      ? "no answer from Jev, dropped"
      : !d.wake
        ? "not for the assistant"
        : capped
          ? "for the assistant, over today's cap"
          : "for the assistant";
    log.info("addressing", what, {
      mode: this.cfg.mode,
      row: msg.rowId,
      reason: d.reason,
      addressed: d.scores?.addressed,
      wants_reply: d.scores?.wants_reply,
      ...(d.error ? { err: d.error } : {}),
    });
    try {
      const path = join(this.o.config.paths.data_dir, "addressing.jsonl");
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(
        path,
        `${JSON.stringify({
          at: new Date(at).toISOString(),
          row: msg.rowId,
          chat: msg.chatGuid,
          mode: this.cfg.mode,
          version: ADDRESS_QUESTIONS_VERSION,
          model: this.cfg.model,
          reason: d.reason,
          scores: d.scores ?? null,
          wake: d.wake,
          capped,
          error: d.error ?? null,
          attempts,
        })}\n`,
      );
    } catch (err) {
      log.warn("addressing", "could not append the decision record", {
        err: (err as Error).message,
      });
    }
  }
}
