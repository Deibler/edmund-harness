import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRecurrence } from "../src/ideation/recurrence.ts";
import { ChatDb } from "../src/imessage/db.ts";

const DM = "any;-;+15550100001";
const DM_ALT = "iMessage;-;+15550100001";
const OTHER = "any;-;+15550100002";
const NOW = Date.parse("2026-11-03T12:00:00-05:00");
const DAY = 86_400_000;
const appleNs = (ms: number) => (ms - 978_307_200_000) * 1_000_000;

const dir = mkdtempSync(join(tmpdir(), "ideation-recurrence-"));
const dbPath = join(dir, "chat.db");
{
  const w = new Database(dbPath);
  w.exec("PRAGMA journal_mode = WAL"); // ChatDb opens read-only and cannot switch it
  w.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
      is_from_me INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0,
      handle_id INTEGER DEFAULT 0);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat VALUES (1, '${DM}', '+15550100001', 45), (2, '${OTHER}', '+15550100002', 45),
      (3, '${DM_ALT}', '+15550100001', 45);
  `);
  const add = (
    row: number,
    chat: number,
    at: number,
    opts: { me?: boolean; assoc?: number } = {},
  ) => {
    w.query(
      `INSERT INTO message (ROWID, guid, text, date, is_from_me, associated_message_type, handle_id)
       VALUES (?, ?, 'q', ?, ?, ?, 1)`,
    ).run(row, `g${row}`, appleNs(at), opts.me ? 1 : 0, opts.assoc ?? 0);
    w.query("INSERT INTO chat_message_join VALUES (?, ?)").run(chat, row);
  };
  add(1, 1, NOW - 1 * DAY); // their question, three separate days
  add(2, 1, NOW - 3 * DAY);
  add(3, 1, NOW - 5 * DAY);
  add(4, 1, NOW - 5 * DAY + 3_600_000); // same day as 3
  add(5, 1, NOW - 7 * DAY, { me: true }); // Edmund's reply
  add(6, 1, NOW - 8 * DAY, { assoc: 2000 }); // a tapback
  add(7, 2, NOW - 9 * DAY); // someone else's chat
  add(8, 1, NOW - 40 * DAY); // too old
  add(9, 3, NOW - 10 * DAY); // their other chat row (same person)
  w.close();
}
const chatDb = new ChatDb(dbPath);
const rule = { nowMs: NOW, windowDays: 30, minDays: 3 };
const mine = [DM, DM_ALT];

describe("verifyRecurrence", () => {
  test("their messages on three separate days recur", () => {
    const r = verifyRecurrence(chatDb, mine, [1, 2, 3], rule);
    expect(r.ok).toBe(true);
    expect(r.days).toHaveLength(3);
    expect(r.rejected).toEqual([]);
  });

  test("two messages on one day count as one day", () => {
    const r = verifyRecurrence(chatDb, mine, [1, 3, 4], rule);
    expect(r.ok).toBe(false);
    expect(r.days).toHaveLength(2);
  });

  test("Edmund's own message cannot make the third day", () => {
    const r = verifyRecurrence(chatDb, mine, [1, 2, 5], rule);
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual([{ rowId: 5, why: "from Edmund" }]);
  });

  test("a reaction cannot make the third day", () => {
    const r = verifyRecurrence(chatDb, mine, [1, 2, 6], rule);
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual([{ rowId: 6, why: "reaction" }]);
  });

  test("another person's message cannot make the third day", () => {
    const r = verifyRecurrence(chatDb, mine, [1, 2, 7], rule);
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual([{ rowId: 7, why: "other chat" }]);
  });

  test("a message from before the window cannot make the third day", () => {
    const r = verifyRecurrence(chatDb, mine, [1, 2, 8], rule);
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual([{ rowId: 8, why: "outside window" }]);
  });

  test("a cited row that does not exist is rejected, not counted", () => {
    const r = verifyRecurrence(chatDb, mine, [1, 2, 99_999], rule);
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual([{ rowId: 99_999, why: "not found" }]);
  });

  test("the same person's second chat row counts as theirs", () => {
    const r = verifyRecurrence(chatDb, mine, [1, 2, 9], rule);
    expect(r.ok).toBe(true);
  });

  test("duplicate and malformed citations add nothing", () => {
    const r = verifyRecurrence(chatDb, mine, [1, 1, 2, 2, -4, 0, 1.5], rule);
    expect(r.ok).toBe(false);
    expect(r.accepted).toEqual([1, 2]);
  });

  test("no chats for the session means nothing recurs", () => {
    expect(verifyRecurrence(chatDb, [], [1, 2, 3], rule).ok).toBe(false);
  });
});
