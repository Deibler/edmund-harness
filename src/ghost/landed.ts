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

/**
 * The fire labels come from what the send path reported, and that is a
 * claim: a fire is stamped `error` when the bridge reported nothing sent
 * (a control-socket timeout can still flush), and `vetoed` on an empty
 * reply (a run that sent through a tool has an empty reply too). Before
 * such a fire stops pacing the next one, look for what actually reached
 * the chat: anything Edmund sent there inside the fire's window marks it
 * delivered. A reply to the person in that window counts as well, which
 * errs toward waiting. When the chat can't be read, the fire counts.
 */
export function withLandingEvidence(
  fires: FireRecord[],
  sessionKey: SessionKey,
  deps: { chatDb: ChatDb; contacts: ContactBook; sms?: GhostSmsHistory },
  nowMs: number,
): FireRecord[] {
  return fires.map((f) =>
    isContact(f, nowMs) ||
    !sentBetween(sessionKey, deps, f.firedAtMs, f.firedAtMs + FIRE_LANDING_WINDOW_MS)
      ? f
      : { ...f, delivered: true },
  );
}

const SENT_BETWEEN_SQL = (n: number) => `
  SELECT 1 AS hit FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  WHERE c.guid IN (${Array(n).fill("?").join(",")})
    AND m.is_from_me = 1
    AND ((m.date / 1000000) + 978307200000) BETWEEN ? AND ?
  LIMIT 1`;

/** Did Edmund send anything in this session's chat in [fromMs, toMs]?
 *  True when that can't be determined. */
function sentBetween(
  sessionKey: SessionKey,
  deps: { chatDb: ChatDb; contacts: ContactBook; sms?: GhostSmsHistory },
  fromMs: number,
  toMs: number,
): boolean {
  try {
    if (isSmsSession(sessionKey)) {
      if (!deps.sms) return true;
      return deps.sms
        .history(chatIdFromKey(sessionKey), 500)
        .some((l) => l.fromMe && l.timestampMs >= fromMs && l.timestampMs <= toMs);
    }
    const guids = chatGuidsForSession(sessionKey, deps.chatDb, deps.contacts);
    if (guids.length === 0) return true;
    const row = deps.chatDb
      .query<{ hit: number }>(SENT_BETWEEN_SQL(guids.length))
      .get(...guids, fromMs, toMs);
    return row !== null && row !== undefined;
  } catch {
    return true;
  }
}
