import { Database } from "bun:sqlite";
/**
 * A scheduled event or a proactive fire that starts without the session's
 * model conversation used to wake with only the event text: a reminder fired
 * into a live DM it could not see, and a proactive fire whose rubric asks
 * "has the user just messaged me?" with nothing to answer from. Inbound cold
 * starts already carried the recent thread. These pin the same for wake-ups,
 * and that a resumed wake-up (which has the conversation) gets nothing extra.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProactiveEnvelope } from "../src/channels/envelope.ts";
import { recentThreadLines, wakeThread } from "../src/channels/history.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { wakeThreadBlock } from "../src/cron/wake-thread.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import { StateStore } from "../src/sessions/store.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const HANDLE = "+15550100002";
const GUID = `any;-;${HANDLE}`;
const KEY = `imessage:dm:${HANDLE}`;
const MEMBER_A = "+15550100011";
const MEMBER_B = "+15550100012";
const GROUP_GUID = "any;+;chat0000000001";
const GROUP_KEY = `imessage:group:${GROUP_GUID}`;
const SMS_GROUP = "CH00000000000000000000000000000002";
const SMS_GROUP_KEY = `sms:group:${SMS_GROUP}`;

const db = emptyChatDb();
{
  const w = new Database(db.path);
  w.exec(`INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, '${GUID}', '${HANDLE}')`);
  w.exec(`INSERT INTO handle (ROWID, id, service) VALUES (1, '${HANDLE}', 'iMessage')`);
  // A group chat with two members, for the roster.
  w.exec(`INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (2, '${GROUP_GUID}', 'chat1')`);
  w.exec(`INSERT INTO handle (ROWID, id, service) VALUES (2, '${MEMBER_A}', 'iMessage')`);
  w.exec(`INSERT INTO handle (ROWID, id, service) VALUES (3, '${MEMBER_B}', 'iMessage')`);
  w.exec("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 2), (2, 3)");
  const lines: [number, number, string][] = [
    [0, 1, "dinner is at 7 now, not 6"],
    [1, 0, "got it, moving the reminder"],
    [0, 1, "and bring the good knife"],
  ];
  lines.forEach(([fromMe, handle, text], i) => {
    const row = i + 1;
    const dateNs = (Date.now() - 978_307_200_000 - (3 - i) * 60_000) * 1_000_000;
    w.exec(
      `INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date) VALUES (${row}, 'G${row}', '${text}', ${fromMe ? 0 : handle}, ${fromMe}, ${dateNs})`,
    );
    w.exec(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ${row})`);
  });
  // Group chatter: one message before the group's last turn, one after.
  const groupLines: [number, string, number][] = [
    [2, "who is driving saturday", 10 * 60_000],
    [3, "I can drive, leaving at 9", 60_000],
  ];
  groupLines.forEach(([handle, text, agoMs], i) => {
    const row = 10 + i;
    const dateNs = (Date.now() - 978_307_200_000 - agoMs) * 1_000_000;
    w.exec(
      `INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date) VALUES (${row}, 'G${row}', '${text}', ${handle}, 0, ${dateNs})`,
    );
    w.exec(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, ${row})`);
  });
  w.close();
}
const chatDb = new ChatDb(db.path);
const dataDir = mkdtempSync(join(tmpdir(), "wake-thread-"));
const state = new StateStore(dataDir);
const config = ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} });
const names: Record<string, string> = { [MEMBER_A]: "Alex", [MEMBER_B]: "Kim" };
const contacts = {
  displayName: (h: string) => names[h] ?? null,
  label: (h: string) => names[h] ?? (h === MEMBER_B_SMS ? `Pat (${h})` : null),
} as unknown as ContactBook;
const MEMBER_B_SMS = "+15550100013";
const sms = {
  history: (conversationId: string) =>
    conversationId === SMS_GROUP
      ? [
          {
            rowId: 1,
            timestampMs: Date.now() - 60_000,
            fromHandle: MEMBER_A,
            fromMe: false,
            text: "she's into Jordan and his weird eggs",
            isTapback: false,
            tapbackTargetIsMe: false,
            tapbackTargetHandle: "",
          },
        ]
      : [],
  groupInfo: (sid: string) =>
    sid === SMS_GROUP ? { friendlyName: null, participants: [MEMBER_A, MEMBER_B_SMS] } : null,
};
const recentThread = (key: string, guid: string, sinceMs?: number) =>
  wakeThread(key, guid, { config, chatDb, contacts, state, sms }, sinceMs);

afterAll(() => {
  chatDb.close();
  db.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});

function session(
  claudeSessionId: string | null,
  key = KEY,
  chatGuid = GUID,
  lastInboundMs = Date.now(),
) {
  state.upsertSession({
    sessionKey: key,
    claudeSessionId,
    chatGuid,
    isGroup: key === KEY ? 0 : 1,
    lastInboundMs,
    lastOutboundMs: 0,
  });
  state.setModelSession(key, claudeSessionId, "claude");
}

describe("wake-ups and the recent thread", () => {
  test("a cold wake-up carries the latest messages", () => {
    session(null);
    const block = wakeThreadBlock(KEY, GUID, config, state, recentThread);
    expect(block).toContain("Recent thread");
    expect(block).toContain("dinner is at 7 now, not 6");
    expect(block).toContain("and bring the good knife");
  });

  test("a DM wake-up has no roster line", () => {
    session(null);
    expect(wakeThreadBlock(KEY, GUID, config, state, recentThread)).not.toContain("Participants:");
  });

  // A reminder written days earlier said someone "is into Jordan" and called
  // it an inside-joke callback. The cold wake-up had the thread but not the
  // roster, and the reply addressed Jordan, who was never in the chat.
  test("a cold wake-up into an SMS group says who is in the room", () => {
    session(null, SMS_GROUP_KEY, `sms:${SMS_GROUP}`);
    const block = wakeThreadBlock(SMS_GROUP_KEY, `sms:${SMS_GROUP}`, config, state, recentThread);
    expect(block).toContain(`Participants: Alex, Pat (${MEMBER_B_SMS})`);
    expect(block).toContain("weird eggs");
    expect(block.indexOf("Participants:")).toBeLessThan(block.indexOf("Recent thread"));
  });

  test("a cold wake-up into an iMessage group carries the chat.db roster", () => {
    session(null, GROUP_KEY, GROUP_GUID);
    const block = wakeThreadBlock(GROUP_KEY, GROUP_GUID, config, state, recentThread);
    expect(block).toContain("Participants: Alex, Kim");
  });

  test("a group wake-up that resumes gets what was said since its last turn", () => {
    session("11111111-2222-3333-4444-555555555555", GROUP_KEY, GROUP_GUID, Date.now() - 5 * 60_000);
    const block = wakeThreadBlock(GROUP_KEY, GROUP_GUID, config, state, recentThread);
    expect(block).toContain("since your last turn here");
    expect(block).toContain("I can drive, leaving at 9");
    expect(block).not.toContain("who is driving saturday");
    expect(block).not.toContain("Participants:");
  });

  test("every daemon wake-up hands the boundary through", () => {
    const main = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
    const calls = main.match(/wakeThread\([^)]*\)/g) ?? [];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toBe("wakeThread(key, guid, deps, sinceMs)");
  });

  test("a second wake-up with no turn between shows only what came after the first", () => {
    // Both group lines are newer than the last inbound turn.
    session(
      "11111111-2222-3333-4444-555555555555",
      GROUP_KEY,
      GROUP_GUID,
      Date.now() - 20 * 60_000,
    );
    const first = wakeThreadBlock(GROUP_KEY, GROUP_GUID, config, state, recentThread);
    expect(first).toContain("who is driving saturday");
    // The first fire replied with plain text: no inbound, no outbound stamp,
    // but runModel recorded the turn.
    state.markModelTurn(GROUP_KEY, Date.now() - 5 * 60_000);
    const second = wakeThreadBlock(GROUP_KEY, GROUP_GUID, config, state, recentThread);
    expect(second).not.toContain("who is driving saturday");
    expect(second).toContain("I can drive, leaving at 9");
    state.markModelTurn(GROUP_KEY, Date.now());
    expect(wakeThreadBlock(GROUP_KEY, GROUP_GUID, config, state, recentThread)).toBe("");
  });

  test("a recovery turn, which lists the unanswered messages itself, gets no warm block", () => {
    session(
      "11111111-2222-3333-4444-555555555555",
      GROUP_KEY,
      GROUP_GUID,
      Date.now() - 20 * 60_000,
    );
    expect(wakeThreadBlock(GROUP_KEY, GROUP_GUID, config, state, recentThread, false)).toBe("");
    const recovery = readFileSync(join(import.meta.dir, "../src/recovery/turn.ts"), "utf8");
    expect(recovery).toMatch(/wakeThreadBlock\([^)]*deps\.recentThread,\s*false,?\s*\)/);
  });

  test("a successful turn of any kind records when it started, outbound untouched", () => {
    const key = "imessage:group:any;+;chat0000000099";
    session(null, key, "any;+;chat0000000099", 1_000);
    state.markModelTurn(key, 5_000);
    state.markModelTurn(key, 4_000); // never moves back
    expect(state.getSession(key)?.lastTurnMs).toBe(5_000);
    expect(state.getSession(key)?.lastOutboundMs).toBe(0);
    const runner = readFileSync(join(import.meta.dir, "../src/model/runner.ts"), "utf8");
    expect(runner).toContain(
      "if (result.ok) store.markModelTurn(rawInput.sessionKey, startedAtMs);",
    );
  });

  test("a resumed group with nothing new gets nothing", () => {
    session("11111111-2222-3333-4444-555555555555", GROUP_KEY, GROUP_GUID, Date.now());
    expect(wakeThreadBlock(GROUP_KEY, GROUP_GUID, config, state, recentThread)).toBe("");
  });

  test("a wake-up that resumes the conversation gets nothing extra", () => {
    session("11111111-2222-3333-4444-555555555555");
    expect(wakeThreadBlock(KEY, GUID, config, state, recentThread)).toBe("");
  });

  test("the mirror and trading sessions have no chat to read", () => {
    expect(recentThreadLines("mirror:pi-4", GUID, { config, chatDb, contacts, state })).toEqual([]);
    expect(
      recentThreadLines(`trading:dm:${HANDLE}`, GUID, { config, chatDb, contacts, state }),
    ).toEqual([]);
  });

  test("a failed read skips the thread instead of stopping the event", () => {
    session(null);
    const broken = () => {
      throw new Error("chat.db locked");
    };
    expect(wakeThreadBlock(KEY, GUID, config, state, broken)).toBe("");
  });

  test("the proactive envelope puts the thread before the rubric that asks about it", () => {
    const env = buildProactiveEnvelope({
      brief: "their trip is tomorrow",
      localTimeLabel: "Thu 4:00 PM",
      recentThread: "Recent thread (…):\n  them: we cancelled the trip",
    });
    const thread = env.indexOf("we cancelled the trip");
    expect(thread).toBeGreaterThan(-1);
    expect(thread).toBeLessThan(env.indexOf("Decision rubric"));
  });
});
