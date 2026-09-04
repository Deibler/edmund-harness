/**
 * An empty chat.db for tests that need a ChatDb object but not its contents.
 *
 * Three suites used to open `config.paths.chat_db`, which is the operator's
 * real message store: the tests read a stranger's conversations on the
 * machine that ran them, and failed outright anywhere that file does not
 * exist, which is every fresh checkout and every CI runner. ChatDb opens
 * read-only, so the file has to exist; the schema below is the shape its
 * queries expect, with no rows.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function emptyChatDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "edmund-chatdb-"));
  const path = join(dir, "chat.db");
  const db = new Database(path);
  // ChatDb opens read-only and sets WAL, which is a write. The real store is
  // already in WAL so the pragma is a no-op there; a fresh file has to be put
  // in WAL here, while it can still be written to.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, handle_id INTEGER,
      is_from_me INTEGER, date INTEGER, attributedBody BLOB, associated_message_guid TEXT,
      associated_message_type INTEGER, is_delivered INTEGER, service TEXT, date_read INTEGER);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT,
      display_name TEXT, service_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT,
      total_bytes INTEGER, transfer_name TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
