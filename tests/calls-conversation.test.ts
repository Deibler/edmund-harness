/**
 * A call belongs to an existing conversation: a person's DM, or the Messages
 * group a Group FaceTime was started from. Both come from keyed sources.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationForPeer } from "../src/calls/conversation.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { ContactBook } from "../src/sessions/contacts.ts";

const PHONE = "+15550100002";
const EMAIL = "friend@example.com";
const GROUP_ID = "6B1C2D3E-0000-4000-8000-00000000ABCD";

const dir = mkdtempSync(join(tmpdir(), "edmund-calls-conv-"));
const path = join(dir, "chat.db");
{
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, group_id TEXT, display_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES (1, '${PHONE}'), (2, '${EMAIL}');
    -- The friend texts from both addresses; the email thread is the live one.
    INSERT INTO chat VALUES (1, 'any;-;${PHONE}', 45, NULL, NULL);
    INSERT INTO chat VALUES (2, 'any;-;${EMAIL}', 45, NULL, NULL);
    INSERT INTO chat VALUES (3, 'any;+;chat777', 43, '${GROUP_ID}', 'Hockey');
    INSERT INTO chat_handle_join VALUES (1, 1), (2, 2), (3, 1);
    INSERT INTO message VALUES (10, 100), (11, 900);
    INSERT INTO chat_message_join VALUES (1, 10), (2, 11);
  `);
  db.close();
}
const chatDb = new ChatDb(path);
const contacts = new ContactBook([{ name: "Friend", handles: [PHONE, EMAIL] }]);

afterAll(() => {
  chatDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("conversationForPeer", () => {
  test("a call from either of a person's addresses is their one DM, on the thread in use", () => {
    for (const handle of [PHONE, EMAIL]) {
      const conversation = conversationForPeer({ kind: "person", handle }, { chatDb, contacts });
      expect(conversation?.sessionKey).toBe(`imessage:dm:${contacts.canon(PHONE)}`);
      expect(conversation?.chatGuid).toBe(`any;-;${EMAIL}`);
      expect(conversation?.isGroup).toBe(false);
      expect(conversation?.label).toBe("Friend");
    }
  });

  test("a Group FaceTime is the Messages group it came from, matched on group_id", () => {
    const conversation = conversationForPeer(
      { kind: "group", messagesGroupId: GROUP_ID.toLowerCase(), handles: [PHONE] },
      { chatDb, contacts },
    );
    expect(conversation?.sessionKey).toBe("imessage:group:any;+;chat777");
    expect(conversation?.chatGuid).toBe("any;+;chat777");
    expect(conversation?.label).toBe("Hockey");
  });

  test("a group call that matches no Messages group has no conversation", () => {
    const conversation = conversationForPeer(
      { kind: "group", messagesGroupId: "00000000-0000-4000-8000-000000000000", handles: [] },
      { chatDb, contacts },
    );
    expect(conversation).toBeNull();
  });

  test("a person never texted still has their DM, with no thread yet", () => {
    const conversation = conversationForPeer(
      { kind: "person", handle: "+15550100009" },
      { chatDb, contacts },
    );
    expect(conversation?.sessionKey).toBe("imessage:dm:+15550100009");
    expect(conversation?.chatGuid).toBe("");
  });
});
