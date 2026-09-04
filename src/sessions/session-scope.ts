import type { ChatDb } from "../imessage/db.ts";
import type { ContactBook } from "./contacts.ts";
import { type SessionKey, chatIdFromKey, isGroupSession, normalizeHandle } from "./key.ts";

/**
 * Which chat rows belong to a session? One to many:
 *  - Group: exactly one chat (match by chat.guid).
 *  - DM: one or more — the canonical handle plus every alias the ContactBook
 *    knows about (phone + email + iCloud variants). Returns all matching
 *    chat.guid values so history/search spans them.
 *
 * DM guids come back most-recently-active first. Callers that read history span
 * the whole list and do not care, but the ones that address a send take the
 * first — and a handle can own several chat rows (the same person over iMessage
 * and SMS, a stale thread, our own address owning both the real conversation and
 * note-to-self). Undefined order meant those sends could land in a chat nobody
 * was reading; ordering by last message makes "the first one" mean "the one
 * we're actually talking in".
 */
export function chatGuidsForSession(
  sessionKey: SessionKey,
  chatDb: ChatDb,
  contacts: ContactBook,
): string[] {
  if (isGroupSession(sessionKey)) return [chatIdFromKey(sessionKey)];

  const canon = chatIdFromKey(sessionKey);
  const handles = withTypePrefixes(handlesForCanon(canon, contacts));
  if (handles.length === 0) return [];

  const placeholders = handles.map(() => "?").join(",");
  const rows = chatDb
    .query<{ guid: string }>(
      // MAX(m.date) is null for a chat with no messages, and SQLite sorts nulls
      // last under DESC, so empty threads fall to the back rather than winning.
      `SELECT c.guid AS guid, MAX(m.date) AS last_at
       FROM chat c
       JOIN chat_handle_join chj      ON chj.chat_id = c.ROWID
       JOIN handle h                  ON h.ROWID = chj.handle_id
       LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
       LEFT JOIN message m            ON m.ROWID = cmj.message_id
       WHERE c.style = 45 AND h.id IN (${placeholders})
       GROUP BY c.guid
       ORDER BY last_at DESC`,
    )
    .all(...handles);
  return rows.map((r) => r.guid);
}

/**
 * Invert ContactBook: given a canonical handle, return every known alias
 * (the canonical itself plus any linked handles). ContactBook only does
 * handle→canon; we walk its internal map to collect all aliases.
 */
function handlesForCanon(canon: string, contacts: ContactBook): string[] {
  const out = new Set<string>([canon]);
  // ContactBook keeps handleToCanon privately; round-trip by testing each
  // known handle. Small N, trivial cost.
  for (const handle of contacts.allKnownHandles()) {
    if (contacts.canon(handle) === canon) out.add(normalizeHandle(handle));
  }
  return [...out];
}

/**
 * Each handle, plus the type-prefixed spelling IMCore stores it under.
 *
 * IMCore labels an address with its type — "e:" for an email, "p:" for a phone —
 * and chat.db grows a *second* handle row and a second chat under that spelling.
 * `normalizeHandle` strips the prefix so a session key names the address once,
 * which is what stopped Edmund answering its own messages. The cost is that the
 * normalized handle no longer matches the prefixed handle row, so a session
 * whose live conversation sits under "e:…" resolved only the un-prefixed chat —
 * for our own address, a thread that had been dead for a day, while everything
 * actually being said went to the other one.
 *
 * Matching both spellings puts every chat for the address in the list, and the
 * recency ordering above then picks the one being talked in.
 */
function withTypePrefixes(handles: string[]): string[] {
  const out = new Set<string>();
  for (const handle of handles) {
    out.add(handle);
    out.add(`${handle.includes("@") ? "e" : "p"}:${handle}`);
  }
  return [...out];
}
