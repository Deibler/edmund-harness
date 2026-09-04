import type { ChatDb } from "./db.ts";
import { decodeMessageText } from "./decode.ts";

const PARTICIPANTS_SQL = `
  SELECT DISTINCT h.id AS handle
  FROM chat c
  JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
  JOIN handle h             ON h.ROWID = chj.handle_id
  WHERE c.guid = ?
  ORDER BY h.id
`;

const CHAT_DISPLAY_NAME_SQL = `
  SELECT display_name FROM chat WHERE guid = ? LIMIT 1
`;

const HANDLE_EXISTS_SQL = `
  SELECT 1 FROM handle WHERE id = ? LIMIT 1
`;

const GROUPS_FOR_HANDLE_SQL = `
  SELECT DISTINCT c.guid AS guid
  FROM chat c
  JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
  JOIN handle h             ON h.ROWID = chj.handle_id
  WHERE c.style = 43 AND h.id = ?
`;

export function getGroupParticipants(chatDb: ChatDb, chatGuid: string): string[] {
  return chatDb
    .query<{ handle: string }>(PARTICIPANTS_SQL)
    .all(chatGuid)
    .map((r) => r.handle)
    .filter(Boolean);
}

const CHAT_ROWID_FOR_GUIDS_SQL = (placeholders: string) => `
  SELECT cmj.chat_id AS rid, MAX(m.date) AS last
  FROM chat c
  JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
  JOIN message m             ON m.ROWID = cmj.message_id
  WHERE c.guid IN (${placeholders})
  GROUP BY cmj.chat_id
  ORDER BY last DESC
  LIMIT 1
`;

/**
 * Resolve a chat ROWID from one or more chat GUIDs, picking whichever chat
 * has the most recent message. DMs can map to several chat rows (an iMessage
 * thread and an SMS thread for the same person); we react in the live one.
 * `imsg react` only accepts a chat ROWID, not a GUID, hence this lookup.
 */
export function chatRowIdForGuids(chatDb: ChatDb, guids: string[]): number | null {
  if (guids.length === 0) return null;
  const placeholders = guids.map(() => "?").join(",");
  const row = chatDb
    .query<{ rid: number | null }>(CHAT_ROWID_FOR_GUIDS_SQL(placeholders))
    .get(...guids);
  return row?.rid ?? null;
}

const LATEST_MESSAGE_IN_GUIDS_SQL = (placeholders: string) => `
  SELECT c.guid AS cguid, m.guid AS mguid, m.is_from_me AS from_me
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  WHERE c.guid IN (${placeholders}) AND m.guid IS NOT NULL
  ORDER BY m.date DESC
  LIMIT 1
`;

/**
 * The single most recent message across one or more chat GUIDs — its message
 * guid plus the chat guid it lives in. Used to target an IMCore-bridge tapback
 * ("react to what was just said"). `fromMe` lets callers decide whether to
 * skip reacting to the bot's own last message.
 */
export function latestMessageInGuids(
  chatDb: ChatDb,
  guids: string[],
): { chatGuid: string; messageGuid: string; fromMe: boolean } | null {
  if (guids.length === 0) return null;
  const placeholders = guids.map(() => "?").join(",");
  const row = chatDb
    .query<{ cguid: string; mguid: string; from_me: number }>(
      LATEST_MESSAGE_IN_GUIDS_SQL(placeholders),
    )
    .get(...guids);
  if (!row) return null;
  return { chatGuid: row.cguid, messageGuid: row.mguid, fromMe: row.from_me === 1 };
}

const RECENT_MESSAGES_IN_GUIDS_SQL = (placeholders: string) => `
  SELECT c.guid AS cguid, m.guid AS mguid, m.is_from_me AS from_me, m.text AS text, m.attributedBody AS body
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  WHERE c.guid IN (${placeholders})
    AND m.guid IS NOT NULL
    AND (m.associated_message_type = 0 OR m.associated_message_type IS NULL)
  ORDER BY m.date DESC
  LIMIT ?
`;

export type ResolvedMessage = {
  chatGuid: string;
  messageGuid: string;
  fromMe: boolean;
  text: string;
};

/**
 * Most recent message across `guids` whose text contains `needle` (case-
 * insensitive substring) — for targeting an action at a *specific* earlier
 * message the model identified by quoting a snippet of it. Scans back at most
 * `lookback` messages, skipping tapback rows. `requireFromMe` restricts the
 * match to the bot's own messages (for edit/unsend).
 */
export function findRecentMessageByText(
  chatDb: ChatDb,
  guids: string[],
  needle: string,
  opts: { lookback?: number; requireFromMe?: boolean } = {},
): ResolvedMessage | null {
  if (guids.length === 0) return null;
  const n = needle.trim().toLowerCase();
  if (!n) return null;
  const placeholders = guids.map(() => "?").join(",");
  const rows = chatDb
    .query<{
      cguid: string;
      mguid: string;
      from_me: number;
      text: string | null;
      body: Uint8Array | null;
    }>(RECENT_MESSAGES_IN_GUIDS_SQL(placeholders))
    .all(...guids, opts.lookback ?? 60);
  for (const r of rows) {
    if (opts.requireFromMe && r.from_me !== 1) continue;
    const text = decodeMessageText(r.text, r.body);
    if (text.toLowerCase().includes(n)) {
      return { chatGuid: r.cguid, messageGuid: r.mguid, fromMe: r.from_me === 1, text };
    }
  }
  return null;
}

const MESSAGE_BY_GUID_SQL = `
  SELECT c.guid AS cguid, m.is_from_me AS from_me, m.text AS text, m.attributedBody AS body
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  WHERE m.guid = ? LIMIT 1
`;

/** Resolve a message guid (e.g. one returned by `search_history`) to its chat
 *  guid + sender + text. Returns null if the guid isn't in chat.db. */
export function resolveMessageGuid(chatDb: ChatDb, messageGuid: string): ResolvedMessage | null {
  const row = chatDb
    .query<{ cguid: string; from_me: number; text: string | null; body: Uint8Array | null }>(
      MESSAGE_BY_GUID_SQL,
    )
    .get(messageGuid);
  if (!row) return null;
  return {
    chatGuid: row.cguid,
    messageGuid,
    fromMe: row.from_me === 1,
    text: decodeMessageText(row.text, row.body),
  };
}

export function getChatDisplayName(chatDb: ChatDb, chatGuid: string): string | null {
  const row = chatDb.query<{ display_name: string | null }>(CHAT_DISPLAY_NAME_SQL).get(chatGuid);
  const name = row?.display_name?.trim();
  return name && name.length > 0 ? name : null;
}

/**
 * True iff this handle has ever appeared in chat.db (DM or group, sender or
 * recipient). Used as the observability gate for relay outbound: we refuse
 * to text numbers we've never seen in any conversation.
 */
export function handleExists(chatDb: ChatDb, handle: string): boolean {
  // bun:sqlite's .get() returns null (not undefined) when no row matches —
  // compare against both to keep the check honest under either driver.
  const row = chatDb.query(HANDLE_EXISTS_SQL).get(handle);
  return row !== undefined && row !== null;
}

/**
 * Group-chat GUIDs that contain this handle as a participant. Used to
 * compute the intersection of "groups the calling user is in" with
 * "groups Edmund is in" for list_contacts. chat.style 43 = group; 45 = DM.
 */
export function groupsForHandle(chatDb: ChatDb, handle: string): string[] {
  return chatDb
    .query<{ guid: string }>(GROUPS_FOR_HANDLE_SQL)
    .all(handle)
    .map((r) => r.guid);
}
