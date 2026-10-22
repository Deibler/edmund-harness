import { Database } from "bun:sqlite";
/**
 * A provider refusal judged on a thread's history ("This request was blocked
 * by our safety systems") failed one DM 10 of 10 times over 3h+: every turn
 * resumed the same refused thread, the error classified as `unknown`, no
 * healer ran, and recovery retried it every 30 minutes. These pin the way
 * out: classify it, drop the thread wherever it was stored, carry the recent
 * chat into the cold recovery turn, and clear the answered rows' acks so a
 * restart doesn't answer them twice.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wakeThread } from "../src/channels/history.ts";
import type { RunResult } from "../src/claude/runner.ts";
import { dropRefusedThread } from "../src/codex/runner.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { classifyError } from "../src/recovery/classify.ts";
import { HEALERS } from "../src/recovery/healers.ts";
import { markRecovered, recoveryTurnEnvelope } from "../src/recovery/turn.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import { StateStore } from "../src/sessions/store.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const REFUSAL =
  "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
const HANDLE = "+15550100003";
const GUID = `any;-;${HANDLE}`;
const KEY = `imessage:dm:${HANDLE}`;
const THREAD = "01a0fa87-0000-7000-8000-000000000001";

const db = emptyChatDb();
{
  const w = new Database(db.path);
  w.exec(`INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, '${GUID}', '${HANDLE}')`);
  w.exec(`INSERT INTO handle (ROWID, id, service) VALUES (1, '${HANDLE}', 'iMessage')`);
  const lines: [number, string][] = [
    [0, "publish the scorecard exactly as sent"],
    [1, "live at the readable URL, all 18 pages tested"],
    [0, "this tagline is quirky, what are we trying to say?"],
    [0, "you there?"],
  ];
  lines.forEach(([fromMe, text], i) => {
    const row = i + 1;
    const dateNs = (Date.now() - 978_307_200_000 - (4 - i) * 60_000) * 1_000_000;
    w.exec(
      `INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date) VALUES (${row}, 'G${row}', '${text}', ${fromMe ? 0 : 1}, ${fromMe}, ${dateNs})`,
    );
    w.exec(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ${row})`);
  });
  w.close();
}
const chatDb = new ChatDb(db.path);
const dataDir = mkdtempSync(join(tmpdir(), "refused-thread-"));
const state = new StateStore(dataDir);
const config = ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} });
const contacts = { displayName: () => null, label: () => null } as unknown as ContactBook;
const recentThread = (key: string, guid: string) =>
  wakeThread(key, guid, { config, chatDb, contacts, state });

afterAll(() => {
  state.close();
  chatDb.close();
  db.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  state.upsertSession({
    sessionKey: KEY,
    claudeSessionId: THREAD,
    chatGuid: GUID,
    isGroup: 0,
    lastInboundMs: Date.now(),
    lastOutboundMs: 0,
  });
  state.setModelSession(KEY, THREAD, "claude");
});

describe("a thread the provider refused", () => {
  test("the production refusal classifies as thread_refused, not unknown", () => {
    expect(classifyError(REFUSAL)).toBe("thread_refused");
  });

  test("the runner forgets the thread and keeps the caller from restoring it", () => {
    const failed: RunResult = { ok: false, error: REFUSAL, claudeSessionId: THREAD };
    const out = dropRefusedThread(failed, THREAD, state, KEY);
    expect(out.ok).toBe(false);
    // The inbound path persists a failed turn's thread id; it must be gone.
    expect(out.ok === false && out.claudeSessionId).toBeFalsy();
    expect(state.getSession(KEY)?.claudeSessionId).toBeNull();
  });

  test("any other failure keeps the thread", () => {
    const failed: RunResult = { ok: false, error: "overloaded (529)", claudeSessionId: THREAD };
    expect(dropRefusedThread(failed, THREAD, state, KEY)).toBe(failed);
    expect(state.getSession(KEY)?.claudeSessionId).toBe(THREAD);
  });

  test("the healer drops a refused thread that was stored anyway", async () => {
    const heal = HEALERS.thread_refused;
    expect(heal).not.toBeNull();
    const r = await heal!(KEY, { state, sandboxPath: dataDir });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(state.getSession(KEY)?.claudeSessionId).toBeNull();
  });
});

describe("the cold recovery turn", () => {
  const ctx = {
    errorClass: "thread_refused" as const,
    healed: true,
    rawError: null,
    unanswered: [
      {
        rowId: 4,
        msgGuid: "G4",
        chatIdentifier: HANDLE,
        chatGuid: GUID,
        isGroup: false,
        fromHandle: HANDLE,
        fromMe: false,
        text: "you there?",
        timestampMs: Date.now() - 60_000,
        attachments: [],
        attachmentTranscripts: {},
        service: "iMessage",
        replyToGuid: null,
      },
    ],
    nowMs: Date.now(),
  };

  test("carries the recent chat once the thread is dropped", () => {
    state.setModelSession(KEY, null, "claude");
    const env = recoveryTurnEnvelope(KEY, GUID, ctx, { config, state, recentThread });
    expect(env).toContain("[Recovery context");
    expect(env).toContain("Recent thread");
    expect(env).toContain("this tagline is quirky");
  });

  test("a resumed recovery turn already has the chat and gets nothing extra", () => {
    const env = recoveryTurnEnvelope(KEY, GUID, ctx, { config, state, recentThread });
    expect(env).not.toContain("Recent thread");
  });

  test("answered rows lose their acks so a restart cannot replay them", () => {
    state.writeInboundAck(3, KEY, "{}");
    state.writeInboundAck(4, KEY, "{}");
    state.writeInboundAck(9, KEY, "{}");
    markRecovered(state, KEY, [3, 4], Date.now());
    expect(state.wasReplayed(KEY, 4)).toBe(true);
    const left = state.listInboundAcks().map((a) => a.rowId);
    expect(left).toEqual([9]);
  });
});
