import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatDb } from "../../../src/imessage/db.ts";
import { classifyReply, findAskGuid, findDecision, tapbackTarget } from "../src/approval.ts";

const APPROVER = "+15555550100";
const OTHER = "+15555550199";
const dir = mkdtempSync(join(tmpdir(), "printer-approval-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const path = join(dir, "chat.db");
const appleNs = (ms: number) => (ms - 978_307_200_000) * 1_000_000;

{
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, handle_id INTEGER, is_from_me INTEGER,
      date INTEGER, attributedBody BLOB, associated_message_guid TEXT, associated_message_type INTEGER);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat VALUES (1, 'any;-;${APPROVER}'), (2, 'any;+;group1'), (3, 'any;+;group2'), (4, 'any;+;group3'), (5, 'any;+;group4');
    INSERT INTO handle VALUES (1, '${APPROVER}'), (2, '${OTHER}');
  `);
  db.close();
}

let rowid = 1;
function add(
  chat: number,
  opts: {
    from?: number | null;
    text?: string;
    at: number;
    type?: number;
    assoc?: string;
    guid?: string;
  },
) {
  const db = new Database(path);
  const id = rowid++;
  db.query(
    "INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, associated_message_type, associated_message_guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    opts.guid ?? `g${id}`,
    opts.text ?? null,
    opts.from ?? null,
    opts.from ? 0 : 1,
    appleNs(opts.at),
    opts.type ?? 0,
    opts.assoc ?? null,
  );
  db.query("INSERT INTO chat_message_join VALUES (?, ?)").run(chat, id);
  db.close();
  return opts.guid ?? `g${id}`;
}

const T = Date.now() - 3600_000;

describe("what counts as a yes", () => {
  test("short plain answers decide; hedged ones do not", () => {
    for (const y of [
      "yes",
      "Yep!",
      "ok print it",
      "go ahead",
      "sure",
      "yeah go for it",
      "👍",
      "Do it",
    ]) {
      expect([y, classifyReply(y, "start")]).toEqual([y, "approve"]);
    }
    for (const n of ["no", "not yet", "wait", "hold off", "nope", "don't"]) {
      expect([n, classifyReply(n, "start")]).toEqual([n, "decline"]);
    }
    for (const h of [
      "yes but swap the blue first",
      "is it PLA?",
      "ok wait",
      "yes after dinner",
      "no problem, go ahead",
      "sure, once Sam is home",
      "",
      "yes ".repeat(20),
    ]) {
      expect([h, classifyReply(h, "start")]).toEqual([h, null]);
    }
  });

  test("for a cancel, 'stop it' and 'cancel it' are the yes", () => {
    expect(classifyReply("yes cancel it", "cancel")).toBe("approve");
    expect(classifyReply("stop it", "cancel")).toBe("approve");
    expect(classifyReply("no keep going", "cancel")).toBe("decline");
    expect(classifyReply("cancel it", "start")).toBe("decline");
  });

  test("tapback targets lose their part prefix", () => {
    expect(tapbackTarget("p:0/ABC-1")).toBe("ABC-1");
    expect(tapbackTarget("bp:ABC-2")).toBe("ABC-2");
  });
});

describe("the decision is read from Messages", () => {
  const chatDb = new ChatDb(path);
  const approvers = [APPROVER];

  test("the approver's yes after the ask approves", () => {
    add(1, { from: null, text: "Can I print the dragon? Reply yes", at: T, guid: "ask1" });
    add(1, { from: 1, text: "yes", at: T + 60_000 });
    const d = findDecision(
      chatDb,
      { chatGuid: `any;-;${APPROVER}`, askedMs: T - 1000, askGuid: "ask1", action: "start" },
      approvers,
    );
    expect(d?.verdict).toBe("approve");
    expect(d?.by).toBe(APPROVER);
  });

  test("a yes from anyone else in a group does not count", () => {
    add(2, { from: null, text: "ask", at: T, guid: "ask2" });
    add(2, { from: 2, text: "yes", at: T + 1000 });
    expect(
      findDecision(
        chatDb,
        { chatGuid: "any;+;group1", askedMs: T - 1000, askGuid: "ask2", action: "start" },
        approvers,
      ),
    ).toBeNull();
    add(2, { from: 1, text: "go ahead", at: T + 2000 });
    expect(
      findDecision(
        chatDb,
        { chatGuid: "any;+;group1", askedMs: T - 1000, askGuid: "ask2", action: "start" },
        approvers,
      )?.text,
    ).toBe("go ahead");
  });

  test("a yes from before the ask is not a yes to it", () => {
    add(3, { from: 1, text: "yes", at: T });
    add(3, { from: null, text: "ask", at: T + 5000, guid: "ask3" });
    expect(
      findDecision(
        chatDb,
        { chatGuid: "any;+;group2", askedMs: T + 4000, askGuid: "ask3", action: "start" },
        approvers,
      ),
    ).toBeNull();
  });

  test("a hedge is skipped and the later plain answer decides", () => {
    add(4, { from: null, text: "ask", at: T, guid: "ask4" });
    add(4, { from: 1, text: "is it PLA?", at: T + 1000 });
    add(4, { from: 1, text: "no", at: T + 2000 });
    expect(
      findDecision(
        chatDb,
        { chatGuid: "any;+;group3", askedMs: T - 1, askGuid: "ask4", action: "start" },
        approvers,
      )?.verdict,
    ).toBe("decline");
  });

  test("a like counts only on the ask itself", () => {
    add(5, { from: null, text: "something else", at: T, guid: "other5" });
    add(5, { from: null, text: "ask", at: T + 1000, guid: "ask5" });
    add(5, { from: 1, at: T + 2000, type: 2001, assoc: "p:0/other5" });
    expect(
      findDecision(
        chatDb,
        { chatGuid: "any;+;group4", askedMs: T + 500, askGuid: "ask5", action: "start" },
        approvers,
      ),
    ).toBeNull();
    add(5, { from: 1, at: T + 3000, type: 2001, assoc: "p:0/ask5" });
    expect(
      findDecision(
        chatDb,
        { chatGuid: "any;+;group4", askedMs: T + 500, askGuid: "ask5", action: "start" },
        approvers,
      )?.verdict,
    ).toBe("approve");
  });

  test("the ask is found by its text among the assistant's own messages", () => {
    expect(findAskGuid(chatDb, "any;+;group4", T + 900, "ask")).toBe("ask5");
  });
});
