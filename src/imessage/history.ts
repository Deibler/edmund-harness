import type { ChatDb } from "./db.ts";
import { decodeMessageText } from "./decode.ts";

export type HistoryLine = {
  rowId: number;
  timestampMs: number;
  fromHandle: string;
  fromMe: boolean;
  text: string;
  /** A reaction (like/laugh/question/dislike) rather than a written message. */
  isTapback: boolean;
  /** True when the reaction was aimed at one of OUR messages. */
  tapbackTargetIsMe: boolean;
  /** Handle of whoever wrote the message the reaction was aimed at. */
  tapbackTargetHandle: string;
};

/**
 * `tapback_target_from_me` / `tapback_target_handle` resolve WHOSE message a
 * reaction was aimed at.
 *
 * A tapback on someone else's message arrives as an ordinary row whose text
 * reads `Questioned "…"`, quoting the target. Without the target's author that
 * is genuinely ambiguous, and it misfired in a group: Sam questioned
 * Jordan's message, the quoted text happened to begin "Edmund, make me a
 * picture…", and Edmund read the reaction as aimed at him and answered her
 * sharply. She corrected him ("I questioned Jordan's message, not yours"), the
 * exchange soured from there, and the whole spiral traces back to a missing
 * join rather than to temperament.
 *
 * Tapback types are 2000-3099; `associated_message_guid` carries an optional
 * `p:0/` or `bp:` protocol prefix, so the join strips it.
 */
const HISTORY_SQL = `
  SELECT
    m.ROWID            AS row_id,
    m.text             AS text,
    m.attributedBody   AS attributed_body,
    m.date             AS date_ns,
    m.is_from_me       AS from_me,
    h.id               AS from_handle,
    CASE WHEN m.associated_message_type BETWEEN 2000 AND 3099 THEN 1 ELSE 0 END AS is_tapback,
    tgt.is_from_me     AS tapback_target_from_me,
    th.id              AS tapback_target_handle
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h         ON h.ROWID = m.handle_id
  LEFT JOIN message tgt
         ON m.associated_message_type BETWEEN 2000 AND 3099
        AND tgt.guid = replace(replace(m.associated_message_guid, 'p:0/', ''), 'bp:', '')
  LEFT JOIN handle th        ON th.ROWID = tgt.handle_id
  WHERE c.guid = ? AND m.ROWID < ?
  ORDER BY m.ROWID DESC
  LIMIT ?
`;

/**
 * Fetch the most recent `limit` messages in a chat, ordered oldest → newest
 * (natural reading order). `beforeRowId` lets us exclude the current inbound
 * batch — pass the lowest ROWID of the batch so we get everything strictly
 * before it.
 */
/**
 * Resolve a "before-time" anchor to a rowid the SQL can use. Returns the
 * highest rowid in the chat with `m.date` strictly less than the given
 * unix ms. If the chat has no message before that time, returns 0 — which
 * `getRecentMessages` interprets as "no candidates."
 */
export function resolveBeforeRowId(chatDb: ChatDb, chatGuid: string, beforeMs: number): number {
  const appleNs = (beforeMs - 978_307_200_000) * 1_000_000;
  const row = chatDb
    .query<{ row_id: number | null }>(
      `SELECT MAX(m.ROWID) AS row_id
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       WHERE c.guid = ? AND m.date < ?`,
    )
    .get(chatGuid, appleNs);
  // +1 because getRecentMessages uses `< beforeRowId`; we want messages
  // strictly before `beforeMs`, which includes the resolved row itself.
  return (row?.row_id ?? 0) + 1;
}

/** Count how many messages exist in the chat strictly before a rowid. */
export function countBefore(chatDb: ChatDb, chatGuid: string, beforeRowId: number): number {
  const row = chatDb
    .query<{ n: number }>(
      `SELECT COUNT(*) AS n
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       WHERE c.guid = ? AND m.ROWID < ?`,
    )
    .get(chatGuid, beforeRowId);
  return row?.n ?? 0;
}

export function getRecentMessages(
  chatDb: ChatDb,
  chatGuid: string,
  beforeRowId: number,
  limit: number,
): HistoryLine[] {
  if (limit <= 0) return [];
  const rows = chatDb
    .query<{
      row_id: number;
      text: string | null;
      attributed_body: Uint8Array | null;
      date_ns: number;
      from_me: number;
      from_handle: string | null;
      is_tapback: number;
      tapback_target_from_me: number | null;
      tapback_target_handle: string | null;
    }>(HISTORY_SQL)
    .all(chatGuid, beforeRowId, limit);

  return rows
    .map((r) => ({
      rowId: r.row_id,
      timestampMs: Math.floor(r.date_ns / 1_000_000) + 978_307_200_000,
      fromHandle: r.from_handle ?? "",
      fromMe: r.from_me === 1,
      text: decodeMessageText(r.text, r.attributed_body),
      isTapback: r.is_tapback === 1,
      tapbackTargetIsMe: r.tapback_target_from_me === 1,
      tapbackTargetHandle: r.tapback_target_handle ?? "",
    }))
    .filter((l) => l.text.length > 0)
    .reverse();
}
