import type { ChatDb } from "./db.ts";
import { decodeMessageText } from "./decode.ts";

type SearchHit = {
  msgGuid: string;
  rowId: number;
  timestampMs: number;
  fromHandle: string;
  fromMe: boolean;
  text: string;
  hasAttachments: boolean;
};

export type AttachmentHit = {
  msgGuid: string;
  rowId: number;
  timestampMs: number;
  fromHandle: string;
  fromMe: boolean;
  filePath: string;
  mimeType: string;
};

export type MessageDetail = SearchHit & { attachments: Array<{ path: string; mime: string }> };

export type SearchFilters = {
  chatGuids: string[];
  query?: string;
  senderHandle?: string;
  sinceMs?: number;
  untilMs?: number;
  limit: number;
};

export type SearchOutcome = {
  hits: SearchHit[];
  /** Timestamp of the OLDEST message the scan examined; null if none. */
  scannedToMs: number | null;
  /** True when the scan reached the start of the window (sinceMs or the
   *  beginning of history) — "no matches" then really means none. False
   *  means the scan cap ended the search early; older matches may exist
   *  beyond scannedToMs. */
  exhausted: boolean;
};

/** Newest-first page size for the query scan. */
const SCAN_CHUNK = 2000;
/** Hard ceiling on rows decoded per search call. On this machine ~95%
 *  of chat.db rows keep their text ONLY in the attributedBody blob
 *  (m.text NULL), so a SQL LIKE can't see them — text matching requires
 *  decoding rows in JS, and this cap bounds that work. */
const SCAN_CAP = 12_000;

/**
 * Full-text + metadata search across a session's chats.
 *
 * With a query, pages newest-first through the WHOLE filter window
 * (decoding attributedBody rows) until `limit` matches are found, the
 * window is exhausted, or SCAN_CAP rows have been examined. The old
 * implementation fetched only the newest `limit` rows and grepped
 * those — "no matches" for anything older than the last ~50 messages,
 * silently, despite being the prompt's designated first-line recall tool.
 */
export function searchMessages(chatDb: ChatDb, f: SearchFilters): SearchOutcome {
  if (f.chatGuids.length === 0) return { hits: [], scannedToMs: null, exhausted: true };

  if (!f.query) {
    const { sql, params } = buildSearchSql(f, f.limit);
    const rows = chatDb.query<MessageRow>(sql).all(...params);
    const hits = rows.map(rowToHit);
    return {
      hits,
      scannedToMs: hits.length > 0 ? hits[hits.length - 1]!.timestampMs : null,
      exhausted: rows.length < f.limit,
    };
  }

  const needle = f.query.toLowerCase();
  const hits: SearchHit[] = [];
  let scanned = 0;
  let scannedToMs: number | null = null;
  let beforeRowId: number | undefined;
  let exhausted = false;

  while (hits.length < f.limit && scanned < SCAN_CAP) {
    const { sql, params } = buildSearchSql(f, SCAN_CHUNK, beforeRowId);
    const rows = chatDb.query<MessageRow>(sql).all(...params);
    for (const r of rows) {
      const h = rowToHit(r);
      scannedToMs = h.timestampMs;
      if (h.text.toLowerCase().includes(needle)) {
        hits.push(h);
        if (hits.length >= f.limit) break;
      }
    }
    scanned += rows.length;
    if (rows.length < SCAN_CHUNK) {
      exhausted = true;
      break;
    }
    beforeRowId = rows[rows.length - 1]!.row_id;
  }
  return { hits, scannedToMs, exhausted };
}

/** List attachments (images, audio, files) in this session. */
export function listAttachments(
  chatDb: ChatDb,
  f: SearchFilters & { mimePrefix?: string },
): AttachmentHit[] {
  if (f.chatGuids.length === 0) return [];
  const placeholders = f.chatGuids.map(() => "?").join(",");
  const clauses: string[] = [`c.guid IN (${placeholders})`];
  const params: unknown[] = [...f.chatGuids];
  if (f.sinceMs) {
    clauses.push("m.date >= ?");
    params.push(appleNsFromUnixMs(f.sinceMs));
  }
  if (f.untilMs) {
    clauses.push("m.date <= ?");
    params.push(appleNsFromUnixMs(f.untilMs));
  }
  if (f.senderHandle) {
    clauses.push("h.id = ?");
    params.push(f.senderHandle);
  }
  if (f.mimePrefix) {
    clauses.push("a.mime_type LIKE ?");
    params.push(`${f.mimePrefix}%`);
  }
  params.push(f.limit);
  const sql = `
    SELECT m.ROWID AS row_id, m.guid AS msg_guid, m.date AS date_ns,
           m.is_from_me AS from_me, h.id AS from_handle,
           a.filename AS filename, a.mime_type AS mime_type
    FROM message m
    JOIN chat_message_join cmj        ON cmj.message_id = m.ROWID
    JOIN chat c                       ON c.ROWID = cmj.chat_id
    JOIN message_attachment_join maj  ON maj.message_id = m.ROWID
    JOIN attachment a                 ON a.ROWID = maj.attachment_id
    LEFT JOIN handle h                ON h.ROWID = m.handle_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY m.ROWID DESC
    LIMIT ?
  `;
  const rows = chatDb
    .query<MessageRow & { filename: string | null; mime_type: string | null }>(sql)
    .all(...params);
  const home = process.env.HOME ?? "";
  return rows
    .filter((r) => r.filename)
    .map((r) => ({
      msgGuid: r.msg_guid,
      rowId: r.row_id,
      timestampMs: unixMsFromAppleNs(r.date_ns),
      fromHandle: r.from_handle ?? "",
      fromMe: r.from_me === 1,
      filePath: (r.filename ?? "").replace(/^~/, home),
      mimeType: r.mime_type ?? "",
    }));
}

/** One message with its attachment paths. */
export function getMessage(chatDb: ChatDb, msgGuid: string): MessageDetail | null {
  const row = chatDb
    .query<MessageRow>(
      `SELECT m.ROWID AS row_id, m.guid AS msg_guid, m.text AS text,
              m.attributedBody AS attributed_body, m.date AS date_ns,
              m.is_from_me AS from_me, h.id AS from_handle
       FROM message m
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE m.guid = ? LIMIT 1`,
    )
    .get(msgGuid);
  if (!row) return null;
  const attachments = chatDb
    .query<{ filename: string | null; mime_type: string | null }>(
      `SELECT a.filename, a.mime_type
       FROM attachment a
       JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
       WHERE maj.message_id = ?`,
    )
    .all(row.row_id);
  const home = process.env.HOME ?? "";
  return {
    ...rowToHit({ ...row, has_attachments: attachments.length }),
    attachments: attachments.map((a) => ({
      path: (a.filename ?? "").replace(/^~/, home),
      mime: a.mime_type ?? "",
    })),
  };
}

// ---- internal ----

type MessageRow = {
  row_id: number;
  msg_guid: string;
  text?: string | null;
  attributed_body?: Uint8Array | null;
  date_ns: number;
  from_me: number;
  from_handle: string | null;
  has_attachments?: number;
};

function buildSearchSql(f: SearchFilters, limit: number, beforeRowId?: number) {
  const placeholders = f.chatGuids.map(() => "?").join(",");
  const clauses: string[] = [`c.guid IN (${placeholders})`];
  const params: unknown[] = [...f.chatGuids];
  if (f.sinceMs) {
    clauses.push("m.date >= ?");
    params.push(appleNsFromUnixMs(f.sinceMs));
  }
  if (f.untilMs) {
    clauses.push("m.date <= ?");
    params.push(appleNsFromUnixMs(f.untilMs));
  }
  if (f.senderHandle) {
    clauses.push("h.id = ?");
    params.push(f.senderHandle);
  }
  if (beforeRowId !== undefined) {
    clauses.push("m.ROWID < ?");
    params.push(beforeRowId);
  }
  params.push(limit);
  const sql = `
    SELECT m.ROWID AS row_id, m.guid AS msg_guid, m.text AS text,
           m.attributedBody AS attributed_body, m.date AS date_ns,
           m.is_from_me AS from_me, h.id AS from_handle,
           (SELECT COUNT(*) FROM message_attachment_join WHERE message_id = m.ROWID) AS has_attachments
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c                ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h         ON h.ROWID = m.handle_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY m.ROWID DESC
    LIMIT ?
  `;
  return { sql, params };
}

function rowToHit(r: MessageRow): SearchHit {
  return {
    msgGuid: r.msg_guid,
    rowId: r.row_id,
    timestampMs: unixMsFromAppleNs(r.date_ns),
    fromHandle: r.from_handle ?? "",
    fromMe: r.from_me === 1,
    text: decodeMessageText(r.text ?? null, r.attributed_body ?? null),
    hasAttachments: (r.has_attachments ?? 0) > 0,
  };
}

function appleNsFromUnixMs(ms: number): number {
  return (ms - 978_307_200_000) * 1_000_000;
}
function unixMsFromAppleNs(ns: number): number {
  return Math.floor(ns / 1_000_000) + 978_307_200_000;
}
