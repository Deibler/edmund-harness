import { Database } from "bun:sqlite";
/**
 * Which conversation does a reply land in?
 *
 * Turn deliveries pass the chat GUID the inbound message arrived on. The
 * paths that only know the session — cron fires, recovery replays, boot
 * flushes — used to hand `deliverReply` the bare handle and let IMCore pick
 * the chat object. IMCore's pick is only as good as its registry: with a
 * poisoned entry (the note-to-self damage a forced-account send leaves in
 * imagent) a cron-delivered caption landed in Edmund's own thread while the
 * turn reply seconds earlier reached the person fine.
 *
 * These tests pin the seam that closed that: `deliverReply` resolves a DM's
 * chat GUID from chat.db whenever the caller did not bring one.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const invoke = mock(() => Promise.resolve({ guid: "G1" }));
mock.module("../src/imessage/bridge/index.ts", () => ({ invoke }));

import { deliverReply } from "../src/channels/deliver.ts";
import type { Config } from "../src/config/config.ts";
import type { EchoCache } from "../src/sessions/echo-cache.ts";

const HANDLE = "+15550100005";
const STALE = `any;-;stale-thread`;
const LIVE = `any;-;${HANDLE}`;

/** Apple epoch nanoseconds, which is what chat.db stores in message.date. */
function appleNs(msSinceUnixEpoch: number): number {
  return (msSinceUnixEpoch - 978_307_200_000) * 1_000_000;
}

/** A chat.db where the handle owns a stale thread and a live one. */
function makeChatDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "edmund-deliver-"));
  const path = join(dir, "chat.db");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER);
  `);
  db.query("INSERT INTO handle (ROWID, id) VALUES (1, ?)").run(HANDLE);
  const chats: Array<[number, string, number]> = [
    [1, STALE, Date.parse("2026-06-01T12:00:00Z")],
    [2, LIVE, Date.parse("2026-07-29T19:00:00Z")],
  ];
  for (const [rowid, guid, lastMs] of chats) {
    db.query("INSERT INTO chat (ROWID, guid, style) VALUES (?, ?, 45)").run(rowid, guid);
    db.query("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, 1)").run(rowid);
    db.query("INSERT INTO message (ROWID, date) VALUES (?, ?)").run(rowid * 10, appleNs(lastMs));
    db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(
      rowid,
      rowid * 10,
    );
  }
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function configFor(chatDbPath: string): Config {
  return {
    behavior: { chunk_chars: 3000, reply_threading: false },
    paths: { chat_db: chatDbPath },
    contacts: [],
  } as unknown as Config;
}

const echoes = { recordSent() {} } as unknown as EchoCache;

/** The chat target the bridge was asked to send to on call `n`. */
function sentChat(n = 0): string {
  const [, options] = invoke.mock.calls[n] as unknown as [string, { chat: string }];
  return options.chat;
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
  invoke.mockClear();
  invoke.mockImplementation(() => Promise.resolve({ guid: "G1" }));
});

describe("deliverReply DM addressing", () => {
  test("a DM without a chatGuid is resolved to the live conversation's GUID", async () => {
    const { path, cleanup } = makeChatDb();
    cleanups.push(cleanup);

    const res = await deliverReply(
      { to: HANDLE, isGroup: false, text: "hello" },
      configFor(path),
      echoes,
    );

    expect(res.sent).toBe(1);
    expect(sentChat()).toBe(LIVE);
  });

  test("an explicit chatGuid is used as given, not re-resolved", async () => {
    const { path, cleanup } = makeChatDb();
    cleanups.push(cleanup);

    await deliverReply(
      { to: HANDLE, isGroup: false, text: "hello", chatGuid: STALE },
      configFor(path),
      echoes,
    );

    expect(sentChat()).toBe(STALE);
  });

  test("a handle with no conversation yet sends by handle, starting the chat", async () => {
    const { path, cleanup } = makeChatDb();
    cleanups.push(cleanup);

    await deliverReply(
      { to: "+15550000000", isGroup: false, text: "hello" },
      configFor(path),
      echoes,
    );

    expect(sentChat()).toBe("+15550000000");
  });

  test("a group target passes through untouched", async () => {
    const { path, cleanup } = makeChatDb();
    cleanups.push(cleanup);

    await deliverReply(
      { to: "any;+;chat123", isGroup: true, text: "hello" },
      configFor(path),
      echoes,
    );

    expect(sentChat()).toBe("any;+;chat123");
  });

  test("an unreadable chat.db degrades to the bare handle instead of dropping the reply", async () => {
    const res = await deliverReply(
      { to: HANDLE, isGroup: false, text: "hello" },
      configFor("/nonexistent/chat.db"),
      echoes,
    );

    expect(res.sent).toBe(1);
    expect(res.errors).toEqual([]);
    expect(sentChat()).toBe(HANDLE);
  });
});
