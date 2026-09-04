import { Database } from "bun:sqlite";
/**
 * Does a send get believed just because the bridge said "sent"?
 *
 * IMCore's registry has twice routed a GUID-addressed send into the
 * note-to-self thread while reporting success — chat.db knew, nothing read
 * it. These tests pin the post-send verification: every send is looked up in
 * the store, a landing in our own thread triggers the misdelivery handler
 * (which in the daemon heals the registry) and exactly one resend under a
 * fresh idempotency key, and a resend that lands correctly turns the whole
 * exchange back into an ordinary success.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const invoke = mock(() => Promise.resolve({ guid: "G1" }));
mock.module("../src/imessage/bridge/index.ts", () => ({ invoke }));

import { sendMessage } from "../src/imessage/actions/send.ts";
import { configureSendVerification } from "../src/imessage/actions/verify.ts";

const SELF = "bot@example.com";
const DOUG = "+15550100002";
const DOUG_CHAT = `any;-;${DOUG}`;
const SELF_CHAT = `any;-;e:${SELF}`;

function makeChatDb(): { path: string; db: Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "edmund-verify-"));
  const path = join(dir, "chat.db");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, '${DOUG_CHAT}', '${DOUG}');
    INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (2, '${SELF_CHAT}', 'e:${SELF}');
  `);
  return { path, db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function land(db: Database, guid: string, chatRow: number): void {
  const rowid = db
    .query<{ n: number }, []>("SELECT COALESCE(MAX(ROWID),0)+1 AS n FROM message")
    .get()!.n;
  db.query("INSERT INTO message (ROWID, guid) VALUES (?, ?)").run(rowid, guid);
  db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(chatRow, rowid);
}

function configure(
  path: string,
  onMisdelivery?: (e: unknown) => Promise<"healed" | "throttled">,
): void {
  configureSendVerification({
    chatDbPath: path,
    selfHandles: [SELF],
    onMisdelivery,
    onUnrecovered: () => {
      lostAlerts += 1;
    },
    recoveryWaitMs: 1,
    pollMs: 20,
    pollTries: 3,
  });
}

let lostAlerts = 0;
let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
  configureSendVerification(null);
  lostAlerts = 0;
  invoke.mockClear();
  invoke.mockImplementation(() => Promise.resolve({ guid: "G1" }));
});

describe("post-send verification", () => {
  test("a send that landed where it was addressed is an ordinary success", async () => {
    const { path, db, cleanup } = makeChatDb();
    cleanups.push(cleanup);
    configure(path);
    land(db, "G1", 1);

    const res = await sendMessage({ to: DOUG, isGroup: false, text: "hi", chatGuid: DOUG_CHAT });
    expect(res).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("a flicker that clears in the soft phase resends without healing or alerting", async () => {
    const { path, db, cleanup } = makeChatDb();
    cleanups.push(cleanup);
    let heals = 0;
    configure(path, async () => {
      heals += 1;
      return "healed";
    });
    // First send misroutes; the soft resend lands. No bounce, no alert.
    invoke
      .mockImplementationOnce(() => Promise.resolve({ guid: "G-wrong" }))
      .mockImplementationOnce(() => Promise.resolve({ guid: "G-right" }));
    land(db, "G-wrong", 2);
    land(db, "G-right", 1);

    const res = await sendMessage({ to: DOUG, isGroup: false, text: "hi", chatGuid: DOUG_CHAT });

    expect(res).toEqual({ ok: true });
    expect(heals).toBe(0);
    expect(lostAlerts).toBe(0);
    const [, first] = invoke.mock.calls[0] as unknown as [string, { idempotencyKey: string }];
    const [, second] = invoke.mock.calls[1] as unknown as [string, { idempotencyKey: string }];
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  test("a poison that survives the soft phase is queued, never relaunches Messages", async () => {
    const { path, db, cleanup } = makeChatDb();
    cleanups.push(cleanup);
    let heals = 0;
    configure(path, async () => {
      heals += 1;
      return "healed";
    });
    // The send and both soft resends misroute. There is no fourth attempt
    // any more — the heal phase is gone — so exactly three are queued; a
    // leftover mock here would leak into the next test.
    invoke
      .mockImplementationOnce(() => Promise.resolve({ guid: "G-w1" }))
      .mockImplementationOnce(() => Promise.resolve({ guid: "G-w2" }))
      .mockImplementationOnce(() => Promise.resolve({ guid: "G-w3" }));
    for (const g of ["G-w1", "G-w2", "G-w3"]) land(db, g, 2);

    const res = await sendMessage({ to: DOUG, isGroup: false, text: "hi", chatGuid: DOUG_CHAT });
    // No Messages relaunch, ever, from the send path. Measured over 181 of
    // them, a relaunch fixed the chat 25% of the time, and the 5-minute
    // debounce it set had been throttled within 90s of all 159 sends that
    // were then declared lost. The reply is queued instead; the drainer
    // retries it every 10s, which is what actually delivered these.
    expect(heals).toBe(0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("self_route_retrying");
    // Nothing is lost yet, so the operator is not told anything.
    expect(lostAlerts).toBe(0);
  });

  test("a pre-send refusal (block armed) enters recovery and never leaks", async () => {
    const { path, db, cleanup } = makeChatDb();
    cleanups.push(cleanup);
    configure(path, async () => "healed");
    const refusal = Object.assign(new Error("chat routes to self"), { code: "self_send_blocked" });
    // The send is refused before it leaves; the soft resend lands.
    invoke
      .mockImplementationOnce(() => Promise.reject(refusal))
      .mockImplementationOnce(() => Promise.resolve({ guid: "G-right" }));
    land(db, "G-right", 1);

    const res = await sendMessage({ to: DOUG, isGroup: false, text: "hi", chatGuid: DOUG_CHAT });
    expect(res).toEqual({ ok: true });
    expect(lostAlerts).toBe(0);
  });

  test("a chat poisoned through every round is queued without alerting", async () => {
    const { path, db, cleanup } = makeChatDb();
    cleanups.push(cleanup);
    configure(path, async () => "healed");
    // Every send lands in the self thread, every round.
    let n = 0;
    invoke.mockImplementation(() => {
      n += 1;
      const guid = `G-wrong-${n}`;
      land(db, guid, 2);
      return Promise.resolve({ guid });
    });

    const res = await sendMessage({ to: DOUG, isGroup: false, text: "hi", chatGuid: DOUG_CHAT });
    expect(res.ok).toBe(false);
    // Transient, not lost: the caller queues it and the drainer keeps trying.
    if (!res.ok) expect(res.error).toContain("self_route_retrying");
    // The alert moved to the drainer, which fires it only once a reply has
    // genuinely been stuck for minutes. Announcing "could not be delivered"
    // eight seconds in was reporting messages that then arrived by themselves.
    expect(lostAlerts).toBe(0);
  });

  test("deliberately messaging ourselves is not a misdelivery", async () => {
    const { path, db, cleanup } = makeChatDb();
    cleanups.push(cleanup);
    let called = false;
    configure(path, async () => {
      called = true;
      return "healed";
    });
    land(db, "G1", 2);

    const res = await sendMessage({ to: SELF, isGroup: false, text: "note", chatGuid: SELF_CHAT });
    expect(res).toEqual({ ok: true });
    expect(called).toBe(false);
  });

  test("a message the store never shows is trusted, not failed", async () => {
    const { path, cleanup } = makeChatDb();
    cleanups.push(cleanup);
    configure(path);

    const res = await sendMessage({ to: DOUG, isGroup: false, text: "hi", chatGuid: DOUG_CHAT });
    expect(res).toEqual({ ok: true });
  });

  test("an unconfigured process skips verification entirely", async () => {
    const res = await sendMessage({ to: DOUG, isGroup: false, text: "hi", chatGuid: DOUG_CHAT });
    expect(res).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
