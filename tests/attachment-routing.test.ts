import { Database } from "bun:sqlite";
/**
 * Where does a file actually go?
 *
 * `send_attachment` used to hand `sendMessage` only the bare handle while
 * `send_message` handed it the chat GUID, so IMCore resolved the conversation
 * itself. For our own address that resolved to the note-to-self thread: six
 * sends in a row left the building, and the tool returned "sent" every time.
 *
 * Two layers are covered here — the target a send is addressed with, and the
 * ordering that decides which GUID "the session's chat" means when a handle
 * owns more than one.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chatTarget } from "../src/imessage/actions/target.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import { chatGuidsForSession } from "../src/sessions/session-scope.ts";

const HANDLE = "bot@example.com";
// Named so that neither ROWID order nor alphabetical order matches recency
// order — otherwise an unordered query passes these tests by luck.
const LIVE = "iMessage;-;zulu-live-conversation";
const SELF = "iMessage;-;alpha-note-to-self";
const EMPTY = "iMessage;-;bravo-never-used";

/** Apple epoch nanoseconds, which is what chat.db stores in message.date. */
function appleNs(msSinceUnixEpoch: number): number {
  return (msSinceUnixEpoch - 978_307_200_000) * 1_000_000;
}

function makeChatDb(): { chatDb: ChatDb; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "edmund-attach-"));
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
  // Deliberately inserted so that the stalest chat has the lowest ROWID: an
  // unordered query returns it first, which is the bug.
  const chats: Array<[number, string, number | null]> = [
    [1, SELF, Date.parse("2026-06-01T12:00:00Z")],
    [2, EMPTY, null],
    [3, LIVE, Date.parse("2026-07-29T19:00:00Z")],
  ];
  for (const [rowid, guid, lastMs] of chats) {
    db.query("INSERT INTO chat (ROWID, guid, style) VALUES (?, ?, 45)").run(rowid, guid);
    db.query("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, 1)").run(rowid);
    if (lastMs === null) continue;
    db.query("INSERT INTO message (ROWID, date) VALUES (?, ?)").run(rowid * 10, appleNs(lastMs));
    db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(
      rowid,
      rowid * 10,
    );
  }
  db.close();
  return {
    chatDb: new ChatDb(path),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("chatGuidsForSession", () => {
  test("puts the most recently active chat first when a handle owns several", () => {
    const { chatDb, cleanup } = makeChatDb();
    try {
      const guids = chatGuidsForSession(`imessage:dm:${HANDLE}`, chatDb, new ContactBook([]));
      expect(guids[0]).toBe(LIVE);
      expect(guids).toHaveLength(3);
    } finally {
      chatDb.close();
      cleanup();
    }
  });

  test("a chat with no messages never wins the first slot", () => {
    const { chatDb, cleanup } = makeChatDb();
    try {
      const guids = chatGuidsForSession(`imessage:dm:${HANDLE}`, chatDb, new ContactBook([]));
      expect(guids.at(-1)).toBe(EMPTY);
      // Still returned — history and search span every thread with this person.
      expect(guids).toContain(SELF);
    } finally {
      chatDb.close();
      cleanup();
    }
  });
});

describe("chatGuidsForSession and IMCore's type prefix", () => {
  /**
   * IMCore stores our own address twice: once plainly, once as
   * "e:bot@example.com". The live conversation sat under the prefixed
   * handle while the session, whose key is normalized without the prefix, could
   * only see the un-prefixed chat — dead for a day. Every send addressed to
   * `chatGuids[0]` went to the empty room.
   */
  function makePrefixedChatDb(): { chatDb: ChatDb; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "edmund-prefix-"));
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
    const rows: Array<[number, string, string, number]> = [
      // The stale chat under the plain handle, and the live one under "e:".
      [1, `any;-;${HANDLE}`, HANDLE, Date.parse("2026-07-28T17:33:00Z")],
      [2, `any;-;e:${HANDLE}`, `e:${HANDLE}`, Date.parse("2026-07-29T19:51:00Z")],
    ];
    for (const [rowid, guid, handleId, lastMs] of rows) {
      db.query("INSERT INTO chat (ROWID, guid, style) VALUES (?, ?, 45)").run(rowid, guid);
      db.query("INSERT INTO handle (ROWID, id) VALUES (?, ?)").run(rowid, handleId);
      db.query("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(rowid, rowid);
      db.query("INSERT INTO message (ROWID, date) VALUES (?, ?)").run(rowid * 10, appleNs(lastMs));
      db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(
        rowid,
        rowid * 10,
      );
    }
    db.close();
    return {
      chatDb: new ChatDb(path),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("finds the chat stored under the type-prefixed handle, and prefers it when live", () => {
    const { chatDb, cleanup } = makePrefixedChatDb();
    try {
      const guids = chatGuidsForSession(`imessage:dm:${HANDLE}`, chatDb, new ContactBook([]));
      expect(guids).toEqual([`any;-;e:${HANDLE}`, `any;-;${HANDLE}`]);
    } finally {
      chatDb.close();
      cleanup();
    }
  });

  test("a phone session matches the p: spelling too", () => {
    const dir = mkdtempSync(join(tmpdir(), "edmund-prefix-p-"));
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
    db.query("INSERT INTO chat (ROWID, guid, style) VALUES (1, 'any;-;p:+15551234567', 45)").run();
    db.query("INSERT INTO handle (ROWID, id) VALUES (1, 'p:+15551234567')").run();
    db.query("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1)").run();
    db.close();
    const chatDb = new ChatDb(path);
    try {
      const guids = chatGuidsForSession("imessage:dm:+15551234567", chatDb, new ContactBook([]));
      expect(guids).toEqual(["any;-;p:+15551234567"]);
    } finally {
      chatDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("chatTarget", () => {
  test("prefers the GUID, and only falls back to the handle without one", () => {
    expect(chatTarget({ to: HANDLE, isGroup: false, chatGuid: LIVE })).toBe(LIVE);
    expect(chatTarget({ to: HANDLE, isGroup: false })).toBe(HANDLE);
  });
});

describe("send_attachment addressing", () => {
  const invoke = mock(() => Promise.resolve({ guid: "G1" }));
  mock.module("../src/imessage/bridge/index.ts", () => ({ invoke }));

  afterEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(() => Promise.resolve({ guid: "G1" }));
  });

  test("a file carries the same chat GUID a text would", async () => {
    const { sendMessage } = await import("../src/imessage/actions/send.ts");

    await sendMessage({ to: HANDLE, isGroup: false, text: "here", chatGuid: LIVE });
    await sendMessage({
      to: HANDLE,
      isGroup: false,
      chatGuid: LIVE,
      attachments: ["/tmp/dog.jpeg"],
    });

    const targets = invoke.mock.calls.map(
      ([, options]) => (options as Record<string, unknown>).chat,
    );
    expect(targets).toEqual([LIVE, LIVE]);
    // The failure this guards: an attachment addressed by handle, which IMCore
    // resolves to whichever chat it likes.
    expect(targets).not.toContain(HANDLE);
  });
});
