import type { ChatDb } from "./db.ts";
import { decodeMessageText } from "./decode.ts";
import type { ReplyContext } from "./types.ts";

/**
 * Resolve the parent of a reply: fetch the message by GUID + its attachment
 * paths. Returns null if the parent is no longer in chat.db (pruned) or the
 * GUID doesn't exist.
 *
 * Used so that when a user replies to a prior message ("edmund explain this"
 * threaded under an image), the model sees the image path and the original
 * text, not just the three-word reply.
 */

const MSG_BY_GUID_SQL = `
  SELECT
    m.ROWID          AS row_id,
    m.guid           AS msg_guid,
    m.text           AS text,
    m.attributedBody AS attributed_body,
    m.date           AS date_ns,
    m.is_from_me     AS from_me,
    h.id             AS from_handle
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.guid = ?
  LIMIT 1
`;

const ATTACH_BY_ROW_SQL = `
  SELECT a.filename AS filename
  FROM message_attachment_join maj
  JOIN attachment a ON a.ROWID = maj.attachment_id
  WHERE maj.message_id = ?
`;

type MsgRow = {
  row_id: number;
  msg_guid: string;
  text: string | null;
  attributed_body: Uint8Array | null;
  date_ns: number;
  from_me: number;
  from_handle: string | null;
};

export function lookupReplyContext(chatDb: ChatDb, guid: string): ReplyContext | null {
  const row = chatDb.query<MsgRow>(MSG_BY_GUID_SQL).get(guid);
  if (!row) return null;

  const home = process.env.HOME ?? "";
  const attachments: string[] = [];
  for (const a of chatDb.query<{ filename: string | null }>(ATTACH_BY_ROW_SQL).all(row.row_id)) {
    const p = (a.filename ?? "").replace(/^~/, home);
    if (p) attachments.push(p);
  }

  return {
    msgGuid: row.msg_guid,
    text: decodeMessageText(row.text, row.attributed_body),
    fromHandle: row.from_handle ?? "",
    fromMe: row.from_me === 1,
    timestampMs: Math.floor(row.date_ns / 1_000_000) + 978_307_200_000,
    attachments,
  };
}
