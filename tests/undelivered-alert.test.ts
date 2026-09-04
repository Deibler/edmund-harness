import { Database } from "bun:sqlite";
/**
 * Does the operator only hear "message could not be delivered" when that is
 * actually true?
 *
 * Send recovery giving up is not the message being lost — the durable outbox
 * and the sweeper usually deliver it within a couple of minutes, and every
 * immediate alert observed in production (2026-08-11/12) was followed by a
 * successful flush seconds later. These tests pin the deferred alert: it
 * answers from ground truth (pending_outbox, then chat.db), alerting on a
 * reply still stuck, staying quiet on one that landed, and still alerting for
 * a send with no outbox behind it that never landed at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorAlert } from "../src/alerts/operator-alert.ts";
import { UndeliveredAlert } from "../src/alerts/undelivered.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { StateStore } from "../src/sessions/store.ts";

const DOUG = "+15550100002";
const DOUG_CHAT = `any;-;${DOUG}`;
const APPLE_EPOCH_MS = 978_307_200_000;

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

function makeChatDb(): { chatDb: ChatDb; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), "edmund-undelivered-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "chat.db");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, is_from_me INTEGER);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, '${DOUG_CHAT}', '${DOUG}');
  `);
  const chatDb = new ChatDb(path);
  cleanups.push(() => chatDb.close());
  return { chatDb, db };
}

function makeState(): StateStore {
  const dir = mkdtempSync(join(tmpdir(), "edmund-undelivered-state-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const state = new StateStore(dir);
  cleanups.push(() => state.close());
  return state;
}

type NotifyCall = { category: string; error: string; context?: Record<string, string | number> };

function recordingAlert(): { alert: OperatorAlert; calls: NotifyCall[] } {
  const calls: NotifyCall[] = [];
  const alert = {
    notify: async (p: NotifyCall) => {
      calls.push(p);
      return true;
    },
  } as unknown as OperatorAlert;
  return { alert, calls };
}

/** An outbound row landed in chat 1 at `atMs` (wall-clock ms). */
function landOutbound(db: Database, atMs: number): void {
  const rowid = db
    .query<{ n: number }, []>("SELECT COALESCE(MAX(ROWID),0)+1 AS n FROM message")
    .get()!.n;
  db.query("INSERT INTO message (ROWID, guid, date, is_from_me) VALUES (?, ?, ?, 1)").run(
    rowid,
    `OUT-${rowid}`,
    (atMs - APPLE_EPOCH_MS) * 1_000_000,
  );
  db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)").run(rowid);
}

const EVENT = {
  guid: "(refused before send)",
  intended: DOUG_CHAT,
  landedChatGuid: "",
  landedIdentifier: "refused before send (chat_mismatch)",
};

describe("deferred undelivered alert", () => {
  test("a reply still stuck in the outbox alerts, with how long it has waited", async () => {
    const { chatDb } = makeChatDb();
    const state = makeState();
    const { alert, calls } = recordingAlert();
    const failedAt = Date.now() - 10_000;
    state.putOutbox({
      sessionKey: `imessage:dm:${DOUG}`,
      replyText: "hey Pat",
      chatGuid: DOUG_CHAT,
      isGroup: 0,
      service: "iMessage",
      nowMs: failedAt,
    });

    await new UndeliveredAlert({ alert, state, chatDb }).check(EVENT, failedAt);

    expect(calls.length).toBe(1);
    expect(calls[0]!.category).toBe("message could not be delivered");
    expect(calls[0]!.error).toContain("stuck in the outbox");
    expect(calls[0]!.context?.session).toBe(`imessage:dm:${DOUG}`);
    // Refused pre-send: there is no landed chat, so the alert doesn't render
    // an empty landed_chat line.
    expect(calls[0]!.context?.landed_chat).toBeUndefined();
  });

  test("a reply that flushed after recovery stays quiet", async () => {
    const { chatDb, db } = makeChatDb();
    const state = makeState();
    const { alert, calls } = recordingAlert();
    const failedAt = Date.now() - 60_000;
    landOutbound(db, failedAt + 17_000); // the observed shape: flushed 17s later

    await new UndeliveredAlert({ alert, state, chatDb }).check(EVENT, failedAt);

    expect(calls.length).toBe(0);
  });

  test("an outbound from before the failure does not count as recovery", async () => {
    const { chatDb, db } = makeChatDb();
    const state = makeState();
    const { alert, calls } = recordingAlert();
    const failedAt = Date.now() - 60_000;
    landOutbound(db, failedAt - 5_000); // an earlier chunk of the same turn

    await new UndeliveredAlert({ alert, state, chatDb }).check(EVENT, failedAt);

    expect(calls.length).toBe(1);
    expect(calls[0]!.error).toContain("was not delivered");
  });

  test("nothing queued and nothing landed alerts — a send with no outbox behind it", async () => {
    const { chatDb } = makeChatDb();
    const state = makeState();
    const { alert, calls } = recordingAlert();

    await new UndeliveredAlert({ alert, state, chatDb }).check(EVENT, Date.now() - 60_000);

    expect(calls.length).toBe(1);
    expect(calls[0]!.error).toContain("was not delivered");
  });

  test("recovery matches the chat by handle even when the flush landed on a sibling guid", async () => {
    const { chatDb, db } = makeChatDb();
    const state = makeState();
    const { alert, calls } = recordingAlert();
    // The same person's other chat row — service-prefixed, as IMCore grows them.
    db.exec(
      `INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (2, 'iMessage;-;${DOUG}', '${DOUG}')`,
    );
    const failedAt = Date.now() - 60_000;
    const rowid = 1;
    db.query("INSERT INTO message (ROWID, guid, date, is_from_me) VALUES (?, ?, ?, 1)").run(
      rowid,
      "OUT-sibling",
      (failedAt + 30_000 - APPLE_EPOCH_MS) * 1_000_000,
    );
    db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, ?)").run(rowid);

    await new UndeliveredAlert({ alert, state, chatDb }).check(EVENT, failedAt);

    expect(calls.length).toBe(0);
  });

  test("report() defers the check and answers once per chat for a burst of failures", async () => {
    const { chatDb } = makeChatDb();
    const state = makeState();
    const { alert, calls } = recordingAlert();
    const undelivered = new UndeliveredAlert({ alert, state, chatDb, graceMs: 15 });

    undelivered.report(EVENT);
    undelivered.report(EVENT); // same chat, still inside the window
    expect(calls.length).toBe(0); // nothing immediate

    await new Promise((r) => setTimeout(r, 80));
    expect(calls.length).toBe(1);
  });
});
