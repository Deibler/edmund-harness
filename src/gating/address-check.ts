import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import { decodeMessageText } from "../imessage/decode.ts";
import { getRecentMessages } from "../imessage/history.ts";
import { getGroupParticipants } from "../imessage/participants.ts";
import { lookupReplyContext } from "../imessage/reply-lookup.ts";
import type { InboundMessage, UnnamedWake } from "../imessage/types.ts";
import { type JevQuestion, askJev } from "../jev/client.ts";
import { allInvocationNames } from "../orchestrators/registry.ts";
import { log } from "../util/log.ts";
import { gateInbound, isAssistantMentioned } from "./allowlist.ts";

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
 *
 * The approach, the measurements behind each threshold, and how to
 * recalibrate are in docs/group-addressing.md.
 */

/** Bump when the questions, criteria or state shape change: scores shift with
 *  wording, and the measured rates in data/addressing/calibration-<version>.json
 *  belong to one wording. */
export const ADDRESS_QUESTIONS_VERSION = "2026-09-24.2";

export type CandidateReason = UnnamedWake["reason"];

/** How far an un-named streak has run: his wakes after the last message
 *  that named him or swipe-replied to him. */
export type Streak = {
  /** Wakes already in the streak, before this message. */
  count: number;
  /** Sum over them of (1 - measured rate): the wrong wakes to expect. */
  expected: number;
};

export type AddressDecision = {
  reason: CandidateReason;
  wake: boolean;
  /** For a message soon after he spoke: how often a message with this
   *  "wants a reply" score was really for him, and where that figure came
   *  from. */
  rate?: { value: number; source: "measured" | "jev" };
  streak?: Streak;
  /** Scores alone would have woken him; the streak budget did not. */
  overBudget?: boolean;
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
          what: `The sender is talking to other people in the chat, or to nobody in particular: banter, reactions, plans between friends, or talking ABOUT ${name} rather than to him. Or it opens with the name of someone else in the chat (\`latestMessage.opensWithNameOf\`), which means it is said to that person.`,
          examples: [
            "(to a friend) Are you at the bar?",
            "Haha no way",
            `Every update makes ${name} weirder`,
            "(opens with a friend's name, right after the sender was talking to him) Sam who's playing Sunday?",
          ],
        },
      },
    },
    wants_reply: {
      type: "noul",
      instructions: `Does the sender of \`latestMessage\` expect or want ${name} to reply to it or act on it?`,
      criteria: {
        true: `The sender is waiting for ${name} to answer, do something, or respond.`,
        false: `No reply from ${name} is expected: the message is for someone else (for example it opens with another member's name, see \`latestMessage.opensWithNameOf\`), or it is a thanks, laugh or reaction that needs no answer.`,
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

/** First names by handle, from the address book. */
export type Contacts = { displayName(handle: string): string | null };

/**
 * True when the message's first word is the first name of someone else in
 * the chat: "Sam who's playing Sunday?" is said to Sam. Jev is sent only the
 * fact, never the name; senders stay letters. Without it Jev had no way to
 * know "Sam" was a person here, and on 2026-09-24 it woke him for such a
 * message at 0.86 because the sender had just been talking to him.
 */
export function opensWithOtherMember(
  msg: InboundMessage,
  chatDb: ChatDb,
  contacts: Contacts | undefined,
  config: Config,
): boolean {
  if (!contacts || !msg.isGroup) return false;
  const first =
    msg.text
      .trim()
      .split(/[\s,.!?:;]+/)[0]
      ?.toLowerCase() ?? "";
  if (first.length < 3) return false;
  const own = new Set(config.identity.names.map((n) => n.toLowerCase()));
  return getGroupParticipants(chatDb, msg.chatGuid)
    .filter((h) => h !== msg.fromHandle)
    .some((h) => {
      const n = (contacts.displayName(h) ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      return n.length >= 3 && !own.has(n) && n === first;
    });
}

const ENGAGED_SQL = `
  SELECT m.ROWID AS row_id, m.text AS text, m.attributedBody AS attributed_body,
         p.is_from_me AS parent_from_me
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN message p ON p.guid = m.thread_originator_guid
   WHERE c.guid = ? AND m.ROWID < ? AND m.is_from_me = 0
     AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
   ORDER BY m.ROWID DESC
   LIMIT 200`;

/**
 * Row id of the last message before `beforeRowId` in which someone addressed
 * him on purpose: said his name, or swipe-replied to one of his messages. An
 * un-named streak starts after it. 0 when none is in the last 200.
 */
export function lastEngagedRow(
  chatDb: ChatDb,
  chatGuid: string,
  beforeRowId: number,
  config: Config,
): number {
  const names = allInvocationNames(config);
  const rows = chatDb
    .query<{
      row_id: number;
      text: string | null;
      attributed_body: Uint8Array | null;
      parent_from_me: number | null;
    }>(ENGAGED_SQL)
    .all(chatGuid, beforeRowId);
  for (const r of rows) {
    if (r.parent_from_me === 1) return r.row_id;
    if (isAssistantMentioned(decodeMessageText(r.text, r.attributed_body), names)) return r.row_id;
  }
  return 0;
}

/** One band of the measured table: of `n` labelled messages soon after he
 *  spoke, with "wants a reply" in [from, to) and "said to him" at or above
 *  the floor, `yes` were really for him. */
export type RateBand = { from: number; to: number; n: number; yes: number; rate: number };
export type Calibration = { version: string; bands: RateBand[] };

/**
 * The table the calibration script writes: tenth-wide bands of "wants a
 * reply", each rate smoothed as (yes + 1) / (n + 2) so a small band never
 * claims certainty.
 */
export function rateBands(
  rows: { wantsReply: number; addressed: number; forHim: boolean }[],
  floor: number,
): RateBand[] {
  const bands: RateBand[] = [];
  for (let i = 0; i < 10; i++) {
    const from = i / 10;
    const to = (i + 1) / 10;
    const inBand = rows.filter(
      (r) =>
        r.addressed >= floor &&
        r.wantsReply >= from &&
        (r.wantsReply < to || (i === 9 && r.wantsReply <= 1)),
    );
    const yes = inBand.filter((r) => r.forHim).length;
    bands.push({ from, to, n: inBand.length, yes, rate: (yes + 1) / (inBand.length + 2) });
  }
  return bands;
}

/**
 * How often a message with this "wants a reply" score was really for him.
 * Jev is documented as calibrated in general, but on this question it is a
 * steep S-curve: 0.7-0.8 was right about half the time and 0.9+ every time
 * (2026-09-24). So the measured band decides, and Jev's own probability is
 * used only where this wording has no measurement.
 */
export function measuredRate(
  wantsReply: number,
  cal: Calibration | null,
): { value: number; source: "measured" | "jev" } {
  const band = cal?.bands.find(
    (b) => wantsReply >= b.from && (wantsReply < b.to || (b.to >= 1 && wantsReply <= 1)),
  );
  if (band && band.n > 0) return { value: band.rate, source: "measured" };
  return { value: wantsReply, source: "jev" };
}

/** The measured table for the current wording, or null when there is none. */
export function loadCalibration(dataDir: string): Calibration | null {
  const path = join(dataDir, "addressing", `calibration-${ADDRESS_QUESTIONS_VERSION}.json`);
  if (!existsSync(path)) return null;
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as { version?: string; rates?: RateBand[] };
    if (f.version !== ADDRESS_QUESTIONS_VERSION || !Array.isArray(f.rates)) return null;
    return { version: f.version, bands: f.rates };
  } catch {
    return null;
  }
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
  facts: { opensWithOtherMember?: boolean } = {},
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
      ...(facts.opensWithOtherMember ? { opensWithNameOf: "someone else in this chat" } : {}),
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
 * What the scores alone decide; the streak budget comes after. A misspelled
 * name or a swipe-reply to him is already aimed his way, so for those "said to
 * him" is enough: he decides whether a thanks or a laugh needs an answer.
 * Soon after he spoke, "wants a reply" must also come with some "said to
 * him": Jev reads "wants a reply" as wanting one from anybody, and all 29
 * wrong wakes in the labelled set were friends asking each other things
 * right after he had spoken.
 */
export function shouldWake(
  reason: CandidateReason,
  scores: { addressed: number; wants_reply: number },
  config: Config,
): boolean {
  const c = config.group_addressing;
  if (reason === "after-assistant") {
    return scores.wants_reply >= c.reply_threshold && scores.addressed >= c.addressed_floor;
  }
  return scores.wants_reply >= c.reply_threshold || scores.addressed >= c.addressed_threshold;
}

export type AddressCheckerOptions = {
  config: Config;
  chatDb: ChatDb;
  /** Names the chat's members, for the "opens with someone else's name" fact. */
  contacts?: Contacts;
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
  /** Each chat's checks, one at a time: a wake must count toward the next
   *  message's streak before that message is judged. */
  private chains = new Map<string, Promise<unknown>>();
  /** His wakes soon after he spoke, by chat, from the decision log. */
  private wakes: Map<string, { row: number; rate: number }[]> | null = null;
  private calibration: Calibration | null | undefined;

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

  check(msg: InboundMessage, reason: CandidateReason): Promise<AddressDecision> {
    const prev = this.chains.get(msg.chatGuid) ?? Promise.resolve();
    const run = prev.then(() => this.checkNow(msg, reason));
    const settled = run.catch(() => {});
    this.chains.set(msg.chatGuid, settled);
    void settled.then(() => {
      if (this.chains.get(msg.chatGuid) === settled) this.chains.delete(msg.chatGuid);
    });
    return run;
  }

  /**
   * How far the current un-named streak in this chat has run. Derived from the
   * records each time: chat.db says when he was last addressed on purpose, the
   * decision log says which wakes came after. A restart loses nothing.
   */
  streak(msg: InboundMessage): Streak {
    const since = lastEngagedRow(this.o.chatDb, msg.chatGuid, msg.rowId, this.o.config);
    const wakes = this.loggedWakes(msg.chatGuid).filter((w) => w.row > since && w.row < msg.rowId);
    return { count: wakes.length, expected: wakes.reduce((sum, w) => sum + (1 - w.rate), 0) };
  }

  private rates(): Calibration | null {
    if (this.calibration === undefined) {
      this.calibration = loadCalibration(this.o.config.paths.data_dir);
      if (!this.calibration) {
        log.warn(
          "addressing",
          "no measured rates for this wording; using Jev's own probability until calibrated",
          { version: ADDRESS_QUESTIONS_VERSION },
        );
      }
    }
    return this.calibration;
  }

  private loggedWakes(chat: string): { row: number; rate: number }[] {
    if (!this.wakes) {
      this.wakes = new Map();
      const path = join(this.o.config.paths.data_dir, "addressing.jsonl");
      if (existsSync(path)) {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line) as {
              row: number;
              chat: string;
              reason: string;
              mode: string;
              wake: boolean;
              capped?: boolean;
              woke?: boolean;
              rate?: number | null;
              scores?: { wants_reply: number } | null;
            };
            // Records from before `woke` was logged: a wake in "on" mode under the cap.
            const woke = d.woke ?? (d.wake && d.mode === "on" && !d.capped);
            const rate = d.rate ?? d.scores?.wants_reply;
            if (woke && d.reason === "after-assistant" && typeof rate === "number") {
              this.remember(d.chat, d.row, rate);
            }
          } catch {
            // A torn line from a crash mid-append: skip it.
          }
        }
      }
    }
    return this.wakes.get(chat) ?? [];
  }

  private remember(chat: string, row: number, rate: number): void {
    const list = this.wakes?.get(chat) ?? [];
    list.push({ row, rate });
    list.sort((a, b) => a.row - b.row);
    this.wakes?.set(chat, list.slice(-100));
  }

  private async checkNow(msg: InboundMessage, reason: CandidateReason): Promise<AddressDecision> {
    const now = this.o.now ?? Date.now;
    let decision: AddressDecision;
    let attempts: string[] = [];
    let opensWithOther = false;
    try {
      opensWithOther = opensWithOtherMember(msg, this.o.chatDb, this.o.contacts, this.o.config);
      const state = addressState(msg, this.o.chatDb, this.o.config, {
        opensWithOtherMember: opensWithOther,
      });
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
      if (reason === "after-assistant") {
        // Each wake soon after he spoke may be a misfire, and his reply opens
        // the next window. Spend at most `streak_budget` expected wrong wakes
        // between times someone names him or swipe-replies to him.
        decision.rate = measuredRate(scores.wants_reply, this.rates());
        decision.streak = this.streak(msg);
        if (
          decision.wake &&
          decision.streak.expected + (1 - decision.rate.value) > this.cfg.streak_budget
        ) {
          decision.wake = false;
          decision.overBudget = true;
        }
      }
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

    if (decision.wake && this.cfg.mode === "on" && !capped && decision.scores) {
      decision.woken = {
        ...msg,
        unnamedWake: {
          reason,
          addressed: decision.scores.addressed,
          wantsReply: decision.scores.wants_reply,
          ...(decision.streak ? { streak: decision.streak.count + 1 } : {}),
        },
      };
    }
    this.record(msg, decision, capped, attempts, now(), opensWithOther);
    return decision;
  }

  private record(
    msg: InboundMessage,
    d: AddressDecision,
    capped: boolean,
    attempts: string[],
    at: number,
    opensWithOther: boolean,
  ): void {
    const woke = d.woken !== undefined;
    if (woke && d.reason === "after-assistant" && d.rate) {
      this.loggedWakes(msg.chatGuid);
      this.remember(msg.chatGuid, msg.rowId, d.rate.value);
    }
    const what = d.error
      ? "no answer from Jev, dropped"
      : d.overBudget
        ? "for the assistant, but the un-named streak is over budget"
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
      ...(d.rate ? { rate: d.rate.value, rate_source: d.rate.source } : {}),
      ...(d.streak
        ? { streak: d.streak.count, expected_wrong: Number(d.streak.expected.toFixed(3)) }
        : {}),
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
          opensWithOther,
          rate: d.rate?.value ?? null,
          rateSource: d.rate?.source ?? null,
          streak: d.streak ?? null,
          streakBudget: d.streak ? this.cfg.streak_budget : null,
          overBudget: d.overBudget ?? false,
          wake: d.wake,
          capped,
          woke,
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
