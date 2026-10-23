/**
 * A DM session must carry the chat.db guid of its chat. Until 2026-10-23 the
 * relay pre-created DM sessions with the bare handle and the upsert never
 * corrected it: 7 live rows, 6 active, invisible to the person-file
 * maintainer, the ghost's outcome scoring and the recovery sweeper, which all
 * look a chat up by guid.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatDb } from "../src/imessage/db.ts";
import { dmChatGuid } from "../src/imessage/participants.ts";
import { StateStore } from "../src/sessions/store.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const A = "+15550100011";
const B = "+15550100012";
const db = emptyChatDb();
{
  const w = new Database(db.path);
  // A has two DM rows; the busier one is the chat.
  w.exec(`INSERT INTO chat (ROWID, guid, chat_identifier) VALUES
    (1, 'iMessage;-;${A}', '${A}'), (2, 'any;-;${A}', '${A}')`);
  w.exec("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1), (2, 2), (2, 3)");
  w.close();
}
const chatDb = new ChatDb(db.path);
const dir = mkdtempSync(join(tmpdir(), "dm-chat-guid-"));
const state = new StateStore(dir);
afterAll(() => {
  state.close();
  chatDb.close();
  db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const session = (key: string, chatGuid: string) => ({
  sessionKey: key as `imessage:dm:${string}`,
  claudeSessionId: null,
  chatGuid,
  isGroup: 0,
  lastInboundMs: 0,
  lastOutboundMs: 0,
});

describe("dmChatGuid", () => {
  test("the busiest DM row in chat.db, else the bridge's convention", () => {
    expect(dmChatGuid(chatDb, A)).toBe(`any;-;${A}`);
    expect(dmChatGuid(chatDb, B)).toBe(`any;-;${B}`);
  });
});

describe("a stored chat guid", () => {
  test("a bare handle is replaced by the real guid on the next upsert", () => {
    state.upsertSession(session(`imessage:dm:${A}`, A));
    state.upsertSession(session(`imessage:dm:${A}`, `any;-;${A}`));
    expect(state.getSession(`imessage:dm:${A}`)?.chatGuid).toBe(`any;-;${A}`);
  });

  test("a real guid is never swapped for another", () => {
    state.upsertSession(session(`imessage:dm:${A}`, `iMessage;-;${A}`));
    expect(state.getSession(`imessage:dm:${A}`)?.chatGuid).toBe(`any;-;${A}`);
  });

  test("boot repair fixes iMessage DMs only, from chat.db", () => {
    state.upsertSession(session(`imessage:dm:${B}`, B));
    state.upsertSession(session(`sms:dm:${B}` as never, `sms:${B}`));
    state.upsertSession(session("mirror:pi-4" as never, "mirror:pi-4"));
    expect(state.repairDmChatGuids((h) => dmChatGuid(chatDb, h))).toBe(1);
    expect(state.getSession(`imessage:dm:${B}`)?.chatGuid).toBe(`any;-;${B}`);
    expect(state.getSession(`sms:dm:${B}` as never)?.chatGuid).toBe(`sms:${B}`);
    expect(state.getSession("mirror:pi-4" as never)?.chatGuid).toBe("mirror:pi-4");
    expect(state.repairDmChatGuids((h) => dmChatGuid(chatDb, h))).toBe(0);
  });
});
