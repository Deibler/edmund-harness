import { Database } from "bun:sqlite";
/**
 * A provider refusal judged on a thread's history ("This request was blocked
 * by our safety systems") failed one DM 10 of 10 times over 3h+: every turn
 * resumed the same refused thread, the error classified as `unknown`, no
 * healer ran, and recovery retried it every 30 minutes. These pin the way
 * out: classify it, drop the thread wherever it was stored, carry the recent
 * chat into the cold recovery turn, and clear the answered rows' acks so a
 * restart doesn't answer them twice. Claude's safeguards took the same shape
 * on 2026-10-23 ("safeguards flagged this message"): four turns and seven
 * /compacts of one DM failed on the same thread.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wakeThread } from "../src/channels/history.ts";
import { type RunResult, inBandHealer } from "../src/claude/runner.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { dropRefusedThread } from "../src/model/runner.ts";
import { classifyError } from "../src/recovery/classify.ts";
import { HEALERS } from "../src/recovery/healers.ts";
import { markRecovered, recoveryTurnEnvelope } from "../src/recovery/turn.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import { StateStore } from "../src/sessions/store.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const REFUSAL =
  "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
const CLAUDE_REFUSAL =
  "API Error: Opus 4.8's safeguards flagged this message. Our intentionally broad safeguards allow us to deliver more capabilities faster, but can sometimes flag legitimate cybersecurity work.";
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

  for (const [backend, error] of [
    ["codex", REFUSAL],
    ["claude", CLAUDE_REFUSAL],
  ] as const) {
    test(`runModel forgets a ${backend} thread and keeps the caller from restoring it`, async () => {
      const failed: RunResult = { ok: false, error, claudeSessionId: THREAD };
      const out = await dropRefusedThread(failed, THREAD, state, KEY, backend);
      expect(out.ok).toBe(false);
      // The inbound path persists a failed turn's thread id; it must be gone.
      expect(out.ok === false && out.claudeSessionId).toBeFalsy();
      expect(state.getSession(KEY)?.claudeSessionId).toBeNull();
    });
  }

  test("any other failure keeps the thread", async () => {
    const failed: RunResult = { ok: false, error: "overloaded (529)", claudeSessionId: THREAD };
    expect(await dropRefusedThread(failed, THREAD, state, KEY, "claude")).toBe(failed);
    expect(state.getSession(KEY)?.claudeSessionId).toBe(THREAD);
  });

  test("the Claude runner never heals a refusal and retries the same resume", () => {
    expect(inBandHealer("thread_refused")).toBeNull();
    expect(inBandHealer("bad_tool_ids")).toBe(HEALERS.bad_tool_ids);
    // Both in-band heal sites (pool and spawn-per-turn) go through it.
    const runner = readFileSync(join(import.meta.dir, "../src/claude/runner.ts"), "utf8");
    expect(runner.match(/HEALERS\[/g)?.length).toBe(1);
    expect(runner.match(/const healer = inBandHealer\(cls\)/g)?.length).toBe(2);
  });

  test("every turn, whichever CLI ran it, passes through the drop", () => {
    const model = readFileSync(join(import.meta.dir, "../src/model/runner.ts"), "utf8");
    expect(model).toMatch(
      /result = await dropRefusedThread\(\s*result,\s*transition\.sessionId,\s*store,\s*rawInput\.sessionKey,\s*backend,?\s*\);/,
    );
  });

  test("a refused /compact re-anchors the thread instead of retrying it", () => {
    const turn = readFileSync(join(import.meta.dir, "../src/channels/turn.ts"), "utf8");
    expect(turn).toContain('await dropRefusedThread(compactResult, null, state, key, "claude")');
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
