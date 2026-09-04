import { Database } from "bun:sqlite";
/**
 * Regression tests for search_history depth.
 *
 * The bug being prevented (2026-07-28): buildSearchSql had no text
 * clause — it fetched the newest `limit` rows and grepped them in JS,
 * so any match older than the last ~50 messages returned "no matches",
 * silently, from the tool MEMORY_RULES designates as first-line recall.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatDb } from "../src/imessage/db.ts";
import { searchMessages } from "../src/imessage/search.ts";

const CHAT_GUID = "iMessage;-;+15550100001";

function appleNs(unixMs: number): number {
  return (unixMs - 978_307_200_000) * 1_000_000;
}

/** Build a minimal chat.db fixture: one chat, `count` messages, with
 *  chosen rows carrying a needle in m.text. */
function fixture(count: number, needleAt: number[]): { chatDb: ChatDb; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "chatdb-"));
  const path = join(dir, "chat.db");
  const db = new Database(path);
  // The real chat.db is WAL; ChatDb's readonly constructor re-asserts the
  // mode, which only works if the file is already WAL.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      date INTEGER, is_from_me INTEGER, handle_id INTEGER
    );
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  db.query("INSERT INTO chat (ROWID, guid) VALUES (1, ?)").run(CHAT_GUID);
  db.query("INSERT INTO handle (ROWID, id) VALUES (1, '+15550100001')").run();
  const base = Date.now() - count * 60_000;
  const needles = new Set(needleAt);
  const insert = db.query(
    "INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?, ?, ?, ?, 0, 1)",
  );
  const join_ = db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)");
  for (let i = 1; i <= count; i++) {
    const text = needles.has(i) ? `we talked about sourdough starters (#${i})` : `filler ${i}`;
    insert.run(i, `guid-${i}`, text, appleNs(base + i * 60_000));
    join_.run(i);
  }
  db.close();
  const chatDb = new ChatDb(path);
  return {
    chatDb,
    cleanup: () => {
      chatDb.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("searchMessages depth", () => {
  test("finds a match far older than the newest `limit` rows", () => {
    // Needle at row 10 of 300 — 290 newer messages on top. The old
    // implementation fetched the newest 50 and returned nothing.
    const { chatDb, cleanup } = fixture(300, [10]);
    try {
      const out = searchMessages(chatDb, {
        chatGuids: [CHAT_GUID],
        query: "sourdough",
        limit: 50,
      });
      expect(out.hits.map((h) => h.msgGuid)).toContain("guid-10");
      expect(out.exhausted).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("stops at `limit` matches, newest first", () => {
    const { chatDb, cleanup } = fixture(100, [5, 40, 90]);
    try {
      const out = searchMessages(chatDb, {
        chatGuids: [CHAT_GUID],
        query: "sourdough",
        limit: 2,
      });
      expect(out.hits.map((h) => h.msgGuid)).toEqual(["guid-90", "guid-40"]);
    } finally {
      cleanup();
    }
  });

  test("no-match reports an exhausted full-window scan", () => {
    const { chatDb, cleanup } = fixture(80, []);
    try {
      const out = searchMessages(chatDb, {
        chatGuids: [CHAT_GUID],
        query: "sourdough",
        limit: 50,
      });
      expect(out.hits).toEqual([]);
      expect(out.exhausted).toBe(true);
      expect(out.scannedToMs).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("rows with NULL text (attributedBody-only shape) don't break the scan", () => {
    const { chatDb, cleanup } = fixture(20, [3]);
    try {
      // Null out some texts to mimic the ~95%-of-rows production shape.
      const raw = new Database(chatDb.db.filename);
      raw.exec("UPDATE message SET text = NULL WHERE ROWID % 2 = 0");
      raw.close();
      const fresh = new ChatDb(chatDb.db.filename);
      const out = searchMessages(fresh, {
        chatGuids: [CHAT_GUID],
        query: "sourdough",
        limit: 10,
      });
      expect(out.hits.map((h) => h.msgGuid)).toContain("guid-3");
      fresh.db.close();
    } finally {
      cleanup();
    }
  });
});
