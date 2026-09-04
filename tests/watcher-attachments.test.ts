import { Database } from "bun:sqlite";
/**
 * Does a photo survive arriving quickly?
 *
 * Messages.app writes a message across several rows — message, then
 * chat_message_join, then attachment — and the 200ms backstop poll reads
 * between those writes. The drain used to INNER JOIN the chat join and demand
 * text-or-attachments immediately, so a half-written image message either
 * never appeared (and the cursor skipped it on the strength of a later row)
 * or appeared empty and was dropped. Three photos in a group chat vanished
 * this way while every text around them arrived.
 *
 * These tests run the real watcher against a live fixture db and insert rows
 * in the same staggered order Messages does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatDb } from "../src/imessage/db.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { startWatcher } from "../src/imessage/watcher.ts";

/** Apple epoch nanoseconds, which is what chat.db stores in message.date. */
function appleNs(msSinceUnixEpoch: number): number {
  return (msSinceUnixEpoch - 978_307_200_000) * 1_000_000;
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "edmund-watcher-"));
  const path = join(dir, "chat.db");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      date INTEGER, is_from_me INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
      service TEXT, associated_message_guid TEXT, associated_message_type INTEGER,
      handle_id INTEGER DEFAULT 0
    );
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, total_bytes INTEGER, user_info BLOB);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO chat (ROWID, guid, chat_identifier, style) VALUES (1, 'any;+;boys', 'boys', 43);
    INSERT INTO handle (ROWID, id) VALUES (7, '+15550001111');
  `);
  return { dir, path, db };
}

function insertText(db: Database, rowid: number, text: string): void {
  db.query(
    `INSERT INTO message (ROWID, guid, text, date, handle_id, service)
     VALUES (?, ?, ?, ?, 7, 'iMessage')`,
  ).run(rowid, `guid-${rowid}`, text, appleNs(Date.now()));
  db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)").run(rowid);
}

/** The message row and chat join, the way an image lands first: attachment rows come later. */
function insertImageMessage(db: Database, rowid: number): void {
  db.query(
    `INSERT INTO message (ROWID, guid, text, date, handle_id, service, cache_has_attachments)
     VALUES (?, ?, '￼', ?, 7, 'iMessage', 1)`,
  ).run(rowid, `guid-${rowid}`, appleNs(Date.now()));
  db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)").run(rowid);
}

function attachFile(db: Database, dir: string, rowid: number, name: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, "jpegbytes");
  db.query("INSERT INTO attachment (ROWID, filename, total_bytes) VALUES (?, ?, 9)").run(
    rowid * 100,
    filePath,
  );
  db.query("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)").run(
    rowid,
    rowid * 100,
  );
  return filePath;
}

/** Polls until `check` passes or the deadline hits. The watcher's own poll is 200ms. */
async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
});

function startFixtureWatcher(overrides: { joinWaitMs?: number; attachmentWaitMs?: number } = {}): {
  db: Database;
  dir: string;
  got: InboundMessage[];
} {
  const { dir, path, db } = makeFixture();
  const chatDb = new ChatDb(path);
  const got: InboundMessage[] = [];
  const stop = startWatcher({
    chatDb,
    chatDbPath: path,
    startCursor: 0,
    onMessage: (m) => got.push(m),
    source: "fs",
    ...overrides,
  });
  cleanups.push(() => {
    stop();
    chatDb.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, got };
}

describe("watcher and half-written messages", () => {
  test("an image whose attachment rows land later is delivered once complete, in order", async () => {
    const { db, dir, got } = startFixtureWatcher();

    // The image lands as Messages writes it: message + join now, files later.
    insertImageMessage(db, 10);
    // A text arrives behind it while the image is still materialising.
    insertText(db, 11, "Edmund do you trust this man");

    // The line is stopped: nothing may pass the incomplete image.
    await delay(700);
    expect(got).toHaveLength(0);

    const filePath = attachFile(db, dir, 10, "IMG_1.JPG");
    await waitFor(() => got.length === 2);

    expect(got.map((m) => m.rowId)).toEqual([10, 11]);
    expect(got[0]!.attachments).toEqual([filePath]);
    expect(got[1]!.text).toBe("Edmund do you trust this man");
  });

  test("a text message flows straight through", async () => {
    const { db, got } = startFixtureWatcher();
    insertText(db, 20, "hello");
    await waitFor(() => got.length === 1);
    expect(got[0]!.text).toBe("hello");
  });

  test("a message whose chat join never lands is skipped after its deadline, not wedged on", async () => {
    const { db, got } = startFixtureWatcher({ joinWaitMs: 400 });

    // Message row only — no chat_message_join. An orphan.
    db.query(
      `INSERT INTO message (ROWID, guid, text, date, handle_id) VALUES (30, 'guid-30', 'lost', ?, 7)`,
    ).run(appleNs(Date.now()));
    insertText(db, 31, "after the orphan");

    await waitFor(() => got.length === 1);
    expect(got[0]!.rowId).toBe(31);
  });

  test("attachments that never materialise stop blocking at the deadline", async () => {
    const { db, got } = startFixtureWatcher({ attachmentWaitMs: 400 });

    insertImageMessage(db, 40); // no attachment rows, ever
    insertText(db, 41, "behind the broken image");

    // The broken image decodes to nothing and is dropped — loudly, in the log —
    // but the line moves again.
    await waitFor(() => got.length === 1);
    expect(got[0]!.rowId).toBe(41);
  });

  test("a two-photo message is held until both photos are present", async () => {
    const { db, dir, got } = startFixtureWatcher();

    // Two placeholders: the message says it carries two files.
    db.query(
      `INSERT INTO message (ROWID, guid, text, date, handle_id, service, cache_has_attachments)
       VALUES (60, 'guid-60', '￼￼', ?, 7, 'iMessage', 1)`,
    ).run(appleNs(Date.now()));
    db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 60)").run();
    const first = attachFile(db, dir, 60, "IMG_A.JPG");

    // One of two attachment rows present: not ready.
    await delay(700);
    expect(got).toHaveLength(0);

    const second = join(dir, "IMG_B.JPG");
    writeFileSync(second, "jpegbytes");
    db.query("INSERT INTO attachment (ROWID, filename, total_bytes) VALUES (6001, ?, 9)").run(
      second,
    );
    db.query(
      "INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (60, 6001)",
    ).run();

    await waitFor(() => got.length === 1);
    expect(got[0]!.attachments).toEqual([first, second]);
  });

  test("a file still downloading holds the message until its size matches", async () => {
    const { db, dir, got } = startFixtureWatcher();

    insertImageMessage(db, 50);
    // Attachment row present, file on disk short of total_bytes: mid-download.
    const filePath = join(dir, "IMG_2.JPG");
    writeFileSync(filePath, "jpeg"); // 4 of 9 bytes
    db.query("INSERT INTO attachment (ROWID, filename, total_bytes) VALUES (5000, ?, 9)").run(
      filePath,
    );
    db.query(
      "INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (50, 5000)",
    ).run();

    await delay(700);
    expect(got).toHaveLength(0);

    writeFileSync(filePath, "jpegbytes"); // download completes
    await waitFor(() => got.length === 1);
    expect(got[0]!.attachments).toEqual([filePath]);
  });
});
