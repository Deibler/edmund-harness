import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatDb } from "../src/imessage/db.ts";
import { confirmEdited, confirmUnsent, messageState } from "../src/imessage/edit-confirm.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

/**
 * chat.db is the outcome; the bridge's return value is a claim. These pin the
 * two signatures Messages writes on this machine (an edit: new text plus a
 * `date_edited` stamp; an unsend: the stamp with the body cleared) and, above
 * all, the case that shipped: a request the app accepted and imagent dropped,
 * which leaves the row exactly as it was.
 */

const GUID = "11111111-2222-3333-4444-555555555555";
const FAST = { timeoutMs: 400, intervalMs: 10 };
const SHORT = { timeoutMs: 60, intervalMs: 10 };

let store: { path: string; cleanup: () => void };
let writer: Database;
let chatDb: ChatDb;

beforeEach(() => {
  store = emptyChatDb();
  writer = new Database(store.path);
  writer.exec(
    `INSERT INTO message (ROWID, guid, text, is_from_me, date, date_edited, date_retracted)
     VALUES (1, '${GUID}', 'first draft', 1, 1, 0, 0)`,
  );
  chatDb = new ChatDb(store.path);
});

afterEach(() => {
  chatDb.close();
  writer.close();
  store.cleanup();
});

/** Applies `sql` a moment later, the way imagent writes after the app returns. */
function later(ms: number, sql: string) {
  setTimeout(() => writer.exec(sql), ms);
}

describe("messageState", () => {
  test("reads the row and returns null for an unknown guid", () => {
    expect(messageState(chatDb, GUID)).toEqual({
      text: "first draft",
      dateEdited: 0,
      dateRetracted: 0,
    });
    expect(messageState(chatDb, "nope")).toBeNull();
  });
});

describe("confirmEdited", () => {
  test("resolves once chat.db shows the new text", async () => {
    const before = messageState(chatDb, GUID);
    later(30, `UPDATE message SET text = 'second draft', date_edited = 5 WHERE ROWID = 1`);
    expect(await confirmEdited(chatDb, GUID, "second draft", before, FAST)).toBeNull();
  });

  test("reports an accepted edit that never landed", async () => {
    const before = messageState(chatDb, GUID);
    const problem = await confirmEdited(chatDb, GUID, "second draft", before, SHORT);
    expect(problem).toContain("did not change");
    expect(messageState(chatDb, GUID)?.text).toBe("first draft");
  });

  test("accepts a stamped edit whose stored text Messages normalized", async () => {
    const before = messageState(chatDb, GUID);
    later(30, `UPDATE message SET text = 'second draft.', date_edited = 5 WHERE ROWID = 1`);
    expect(await confirmEdited(chatDb, GUID, "second draft", before, FAST)).toBeNull();
  });

  test("does not mistake a cleared body for an edit", async () => {
    const before = messageState(chatDb, GUID);
    writer.exec(`UPDATE message SET text = NULL, date_edited = 5 WHERE ROWID = 1`);
    expect(await confirmEdited(chatDb, GUID, "second draft", before, SHORT)).toContain(
      "did not change",
    );
  });

  test("a second edit needs a newer stamp than the first", async () => {
    writer.exec(`UPDATE message SET text = 'second draft', date_edited = 5 WHERE ROWID = 1`);
    const before = messageState(chatDb, GUID);
    expect(await confirmEdited(chatDb, GUID, "third draft", before, SHORT)).toContain(
      "did not change",
    );
  });
});

describe("confirmUnsent", () => {
  test("resolves once the stamp advances and the body is cleared", async () => {
    const before = messageState(chatDb, GUID);
    later(30, `UPDATE message SET text = NULL, date_edited = 5 WHERE ROWID = 1`);
    expect(await confirmUnsent(chatDb, GUID, before, FAST)).toBeNull();
  });

  test("honors date_retracted when a release starts setting it", async () => {
    const before = messageState(chatDb, GUID);
    later(30, `UPDATE message SET date_retracted = 5 WHERE ROWID = 1`);
    expect(await confirmUnsent(chatDb, GUID, before, FAST)).toBeNull();
  });

  test("reports an accepted unsend that never landed", async () => {
    const before = messageState(chatDb, GUID);
    expect(await confirmUnsent(chatDb, GUID, before, SHORT)).toContain("was not retracted");
  });

  test("a stamped edit with the body still there is not an unsend", async () => {
    const before = messageState(chatDb, GUID);
    writer.exec(`UPDATE message SET text = 'second draft', date_edited = 5 WHERE ROWID = 1`);
    expect(await confirmUnsent(chatDb, GUID, before, SHORT)).toContain("was not retracted");
  });
});
