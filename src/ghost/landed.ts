import type { ChatDb } from "../imessage/db.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { type SessionKey, chatIdFromKey, isSmsSession } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import { isContact } from "./budget.ts";
import type { FireRecord } from "./prefs.ts";
import type { GhostSmsHistory } from "./think.ts";

/**
 * How long after a fire is recorded its message can still land: the main
 * run (bounded by the turn timeout) plus a send that timed out on the
 * bridge control socket and flushed minutes later.
 */
export const FIRE_LANDING_WINDOW_MS = 30 * 60_000;

/** What reached the chat in a fire's window:
 *  - "unprompted": Edmund wrote before anyone else did (the fire's message);
 *  - "answering": Edmund wrote, but only after someone else had;
 *  - "none": Edmund wrote nothing (or the session has no chat at all);
 *  - "unknown": the chat could not be read. */
export type Landing = "unprompted" | "answering" | "none" | "unknown";

export type LandingDeps = {
  chatDb: ChatDb;
  /** Absent: the session key's own handle is the only one looked up. */
  contacts?: ContactBook;
  sms?: GhostSmsHistory;
};

/** Persists a fire that landed despite its label (GhostPrefsStore). */
export type FireReopener = { reopenFire: (fireId: number) => void };

/**
 * The fire labels come from what the send path reported, and that is a
 * claim: a fire is stamped `error` when the bridge reported nothing sent
 * (a control-socket timeout can still flush), and `vetoed` on an empty
 * reply (a run that sent through a tool has an empty reply too). Before
 * such a fire stops pacing the next one, look at what reached the chat.
 *
 * Edmund writing first in the window is the fire's own message: the fire
 * becomes delivered and pending, which holds the one-open-thread gate and
 * lets the outcome sweep score it, and with `store` that correction is
 * saved so every other gate (the send-time recheck included) sees it.
 * Edmund writing only after someone else did, or a chat that can't be
 * read, still counts toward pacing but is not saved: scoring a reply to
 * the person as a proactive move is how 10 of 35 outcomes once went
 * phantom.
 */
export function withLandingEvidence(
  fires: FireRecord[],
  sessionKey: SessionKey,
  deps: LandingDeps,
  nowMs: number,
  store?: FireReopener,
): FireRecord[] {
  return fires.map((f) => {
    if (isContact(f, nowMs)) return f;
    const landing = landingIn(sessionKey, deps, f.firedAtMs, f.firedAtMs + FIRE_LANDING_WINDOW_MS);
    if (landing === "none") return f;
    if (landing !== "unprompted") return { ...f, delivered: true };
    store?.reopenFire(f.id);
    return { ...f, delivered: true, outcome: null, outcomeAtMs: null, reactionGlyph: null };
  });
}

const SELF_ONLY = {
  allKnownHandles: () => [],
  canon: (h: string) => h,
} as unknown as ContactBook;

const IN_CHATS = (n: number) => `
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  WHERE c.guid IN (${Array(n).fill("?").join(",")})
    AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)`;
const TS = "((m.date / 1000000) + 978307200000)";
const FIRST_SENT_SQL = (n: number) =>
  `SELECT MIN(${TS}) AS at ${IN_CHATS(n)} AND m.is_from_me = 1 AND ${TS} BETWEEN ? AND ?`;
const ANY_RECEIVED_SQL = (n: number) =>
  `SELECT 1 AS hit ${IN_CHATS(n)} AND m.is_from_me = 0 AND ${TS} >= ? AND ${TS} < ? LIMIT 1`;

/** Reactions are not messages: neither side's tapback counts. */
export function landingIn(
  sessionKey: SessionKey,
  deps: LandingDeps,
  fromMs: number,
  toMs: number,
): Landing {
  try {
    if (isSmsSession(sessionKey)) {
      if (!deps.sms) return "unknown";
      const lines = deps.sms
        .history(chatIdFromKey(sessionKey), 500)
        .filter((l) => !l.isTapback && l.timestampMs >= fromMs && l.timestampMs <= toMs);
      const sent = lines.find((l) => l.fromMe);
      if (!sent) return "none";
      return lines.some((l) => !l.fromMe && l.timestampMs < sent.timestampMs)
        ? "answering"
        : "unprompted";
    }
    const guids = chatGuidsForSession(sessionKey, deps.chatDb, deps.contacts ?? SELF_ONLY);
    // No chat row for the session: chat.db holds every message the bridge
    // delivered, so nothing reached one.
    if (guids.length === 0) return "none";
    const sent = deps.chatDb
      .query<{ at: number | null }>(FIRST_SENT_SQL(guids.length))
      .get(...guids, fromMs, toMs)?.at;
    if (sent === null || sent === undefined) return "none";
    const before = deps.chatDb
      .query<{ hit: number }>(ANY_RECEIVED_SQL(guids.length))
      .get(...guids, fromMs, sent);
    return before ? "answering" : "unprompted";
  } catch {
    return "unknown";
  }
}
