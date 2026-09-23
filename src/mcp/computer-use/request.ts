/**
 * What the person actually asked for, read from chat.db.
 *
 * The safety check weighs an action against the request. The model's own
 * explanation is one account of that request, and a manipulated model would
 * give a false one, so the classifier also gets the person's latest messages
 * from the system of record.
 */

import type { Config } from "../../config/config.ts";
import { ChatDb } from "../../imessage/db.ts";
import { getRecentMessages } from "../../imessage/history.ts";
import { AddressBook } from "../../sessions/address-book.ts";
import { ContactBook } from "../../sessions/contacts.ts";
import { chatGuidsForSession } from "../../sessions/session-scope.ts";

const MESSAGES = 3;
const SCAN = 30;
const MAX_CHARS = 500;

/**
 * A reader for the latest messages people sent in this session's chats,
 * oldest first, each with who said it ("Sam: draw us a heart"): in a group
 * that is the only way to know which member asked. Empty when the session
 * has no chat (a cron turn, the mirror) or chat.db cannot be read.
 */
export function requestReader(config: Config, sessionKey: string): () => string[] {
  let db: ChatDb | null = null;
  let guids: string[] | null = null;
  let contacts: ContactBook | null = null;
  return () => {
    db ??= new ChatDb(config.paths.chat_db);
    contacts ??= new ContactBook(config.contacts, new AddressBook());
    guids ??= chatGuidsForSession(sessionKey, db, contacts);
    const lines = guids.flatMap((guid) =>
      getRecentMessages(db!, guid, Number.MAX_SAFE_INTEGER, SCAN),
    );
    return lines
      .filter((l) => !l.fromMe && !l.isTapback)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .slice(-MESSAGES)
      .map((l) => {
        const who =
          (l.fromHandle && contacts!.displayName(l.fromHandle)) || l.fromHandle || "someone";
        const said = l.text.length > MAX_CHARS ? `${l.text.slice(0, MAX_CHARS)}…` : l.text;
        return `${who}: ${said}`;
      });
  };
}
