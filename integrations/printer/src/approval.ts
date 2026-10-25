import type { ChatDb } from "../../../src/imessage/db.ts";
import { decodeMessageText } from "../../../src/imessage/decode.ts";
import { normalizeHandle } from "../../../src/sessions/key.ts";
import type { ApprovalAction } from "./store.ts";

/**
 * Whether the approver said yes, read from chat.db and nowhere else.
 *
 * The model never reports an approval; it cannot, because the only thing
 * that counts is a message in Messages' own database, from an approver's
 * handle, in the chat the ask went to, after the ask. A short plain answer
 * ("yes", "go ahead", "ok print it") or a like/love tapback on the ask is a
 * yes. Anything hedged ("yes but swap the blue first", "is it PLA?") is not a
 * decision either way, and the conversation carries on until there is one.
 */

export type Verdict = "approve" | "decline";

export type Decision = {
  verdict: Verdict;
  by: string;
  text: string;
  ms: number;
  guid: string;
};

const APPROVE =
  /\b(yes|yep|yeah|yea|yup|ya|sure|ok|okay|k|go|approved?|lgtm|do it|print it|send it|start it|run it|go ahead|go for it|sounds good|let'?s go|fire away|you may|green light|resume it)\b|👍|👌|✅/u;
const DECLINE =
  /\b(no|nope|nah|don'?t|do not|not yet|not now|wait|hold|hold off|stop|cancel|later|hang on|negative|keep going|leave it)\b|👎|❌/u;
const HEDGE = /\b(but|first|after|once|until|when|if|unless|before|instead)\b|\?/;

/** A plain yes or no to the ask, or null when the reply is not a decision. */
export function classifyReply(text: string, action: ApprovalAction): Verdict | null {
  const t = text.trim().toLowerCase().replace(/[’]/g, "'");
  if (!t) return null;
  if (t.split(/\s+/).length > 12) return null;
  if (HEDGE.test(t)) return null;
  // For a cancel, "cancel it" and "stop" are the yes.
  const stripped =
    action === "cancel" ? t.replace(/\b(cancel|stop|kill)( it| the print)?\b/g, " yes ") : t;
  const yes = APPROVE.test(stripped);
  const no = DECLINE.test(stripped);
  if (yes && !no) return "approve";
  if (no && !yes) return "decline";
  return null;
}

const APPLE_EPOCH_MS = 978_307_200_000;
const toAppleNs = (ms: number) => (ms - APPLE_EPOCH_MS) * 1_000_000;
const fromApple = (d: number) =>
  d > 1e14 ? Math.floor(d / 1_000_000) + APPLE_EPOCH_MS : d * 1000 + APPLE_EPOCH_MS;

/** A tapback's target guid comes as "p:0/<guid>" or "bp:<guid>". */
export function tapbackTarget(assoc: string): string {
  return assoc.replace(/^(p:\d+\/|bp:)/, "");
}

const REPLIES_SQL = `
  SELECT m.guid AS guid, m.text AS text, m.attributedBody AS body, m.date AS date,
         h.id AS handle, m.associated_message_type AS atype, m.associated_message_guid AS aguid
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE c.guid = ? AND m.is_from_me = 0 AND m.date > ?
  ORDER BY m.date ASC
  LIMIT 200`;

/**
 * The first decision an approver made on this ask, or null. Tapbacks count
 * only on the ask itself (or, when its guid was never found, on a message
 * Edmund sent at or after the ask).
 */
export function findDecision(
  chatDb: ChatDb,
  ask: { chatGuid: string; askedMs: number; askGuid: string; action: ApprovalAction },
  approvers: string[],
): Decision | null {
  const allowed = new Set(approvers.map(normalizeHandle));
  const rows = chatDb
    .query<{
      guid: string;
      text: string | null;
      body: Uint8Array | null;
      date: number;
      handle: string | null;
      atype: number | null;
      aguid: string | null;
    }>(REPLIES_SQL)
    .all(ask.chatGuid, toAppleNs(ask.askedMs));
  for (const r of rows) {
    const by = normalizeHandle(r.handle ?? "");
    if (!allowed.has(by)) continue;
    const ms = fromApple(r.date);
    const atype = r.atype ?? 0;
    if (atype >= 2000 && atype <= 2005) {
      const target = tapbackTarget(r.aguid ?? "");
      if (!isTheAsk(chatDb, target, ask)) continue;
      if (atype === 2000 || atype === 2001) {
        return {
          verdict: "approve",
          by,
          text: atype === 2000 ? "(loved the ask)" : "(liked the ask)",
          ms,
          guid: r.guid,
        };
      }
      if (atype === 2002)
        return { verdict: "decline", by, text: "(disliked the ask)", ms, guid: r.guid };
      continue;
    }
    if (atype !== 0) continue;
    const text = decodeMessageText(r.text, r.body);
    const verdict = classifyReply(text, ask.action);
    if (verdict) return { verdict, by, text, ms, guid: r.guid };
  }
  return null;
}

function isTheAsk(
  chatDb: ChatDb,
  target: string,
  ask: { askedMs: number; askGuid: string },
): boolean {
  if (!target) return false;
  if (ask.askGuid) return target === ask.askGuid;
  const row = chatDb
    .query<{ from_me: number; date: number }>(
      "SELECT is_from_me AS from_me, date FROM message WHERE guid = ? LIMIT 1",
    )
    .get(target);
  return !!row && row.from_me === 1 && fromApple(row.date) >= ask.askedMs - 5_000;
}

/** The guid of the ask Edmund just sent, found by its text in the chat it went to. */
export function findAskGuid(
  chatDb: ChatDb,
  chatGuid: string,
  sinceMs: number,
  snippet: string,
): string {
  const rows = chatDb
    .query<{ guid: string; text: string | null; body: Uint8Array | null }>(
      `SELECT m.guid AS guid, m.text AS text, m.attributedBody AS body
       FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       WHERE c.guid = ? AND m.is_from_me = 1 AND m.date >= ?
       ORDER BY m.date DESC LIMIT 20`,
    )
    .all(chatGuid, toAppleNs(sinceMs - 5_000));
  const needle = snippet.trim().slice(0, 40).toLowerCase();
  for (const r of rows) {
    if (decodeMessageText(r.text, r.body).toLowerCase().includes(needle)) return r.guid;
  }
  return "";
}
