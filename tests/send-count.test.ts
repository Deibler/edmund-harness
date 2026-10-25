import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { ChatDb } from "../src/imessage/db.ts";
import { countSentSince } from "../src/imessage/participants.ts";
import { sendCountNote } from "../src/mcp/tools/message.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const { path, cleanup } = emptyChatDb();
afterAll(cleanup);

const appleNs = (ms: number) => (ms - 978_307_200_000) * 1_000_000;
const now = Date.now();
{
  const db = new Database(path);
  db.exec(`INSERT INTO chat (ROWID, guid) VALUES (1, 'any;+;chat1'), (2, 'any;-;+15555550101')`);
  const add = (id: number, chat: number, fromMe: number, agoMin: number, assoc = 0) => {
    db.query(
      "INSERT INTO message (ROWID, guid, is_from_me, date, associated_message_type) VALUES (?, ?, ?, ?, ?)",
    ).run(id, `g${id}`, fromMe, appleNs(now - agoMin * 60_000), assoc);
    db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(chat, id);
  };
  // Group chat: five sends in the last ten minutes, one older, one reaction,
  // and a message from someone else.
  for (let i = 0; i < 5; i++) add(10 + i, 1, 1, i + 1);
  add(20, 1, 1, 30);
  add(21, 1, 1, 2, 2000);
  add(22, 1, 0, 1);
  // DM: one send.
  add(30, 2, 1, 1);
  db.close();
}
const chatDb = new ChatDb(path);

describe("the model sees how many messages it just sent", () => {
  test("counts the assistant's own messages in the window, not reactions or others'", () => {
    expect(countSentSince(chatDb, ["any;+;chat1"], now - 10 * 60_000)).toBe(5);
    expect(countSentSince(chatDb, ["any;-;+15555550101"], now - 10 * 60_000)).toBe(1);
    expect(countSentSince(chatDb, [], now)).toBe(0);
  });

  test("a few sends say just 'sent'; a run of them says how many", () => {
    expect(sendCountNote({ chatDb, chatGuids: ["any;-;+15555550101"] })).toBe("sent");
    const many = sendCountNote({ chatDb, chatGuids: ["any;+;chat1"] });
    expect(many).toContain("5 messages from you in this chat in the last 10 minutes");
  });
});
