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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProactiveEnvelope } from "../src/channels/envelope.ts";
import { recentThreadLines } from "../src/channels/history.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { wakeThreadBlock } from "../src/cron/wake-thread.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import { StateStore } from "../src/sessions/store.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const HANDLE = "+15550100002";
const GUID = `any;-;${HANDLE}`;
const KEY = `imessage:dm:${HANDLE}`;

const db = emptyChatDb();
{
  const w = new Database(db.path);
  w.exec(`INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, '${GUID}', '${HANDLE}')`);
  w.exec(`INSERT INTO handle (ROWID, id, service) VALUES (1, '${HANDLE}', 'iMessage')`);
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
  w.close();
}
const chatDb = new ChatDb(db.path);
const dataDir = mkdtempSync(join(tmpdir(), "wake-thread-"));
const state = new StateStore(dataDir);
const config = ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} });
const contacts = { displayName: () => null } as unknown as ContactBook;
const recentThread = (key: string, guid: string) =>
  recentThreadLines(key, guid, { config, chatDb, contacts, state });

afterAll(() => {
  chatDb.close();
  db.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});

function session(claudeSessionId: string | null) {
  state.upsertSession({
    sessionKey: KEY,
    claudeSessionId,
    chatGuid: GUID,
    isGroup: 0,
    lastInboundMs: Date.now(),
    lastOutboundMs: 0,
  });
  state.setModelSession(KEY, claudeSessionId, "claude");
}

describe("wake-ups and the recent thread", () => {
  test("a cold wake-up carries the latest messages", () => {
    session(null);
    const block = wakeThreadBlock(KEY, GUID, config, state, recentThread);
    expect(block).toContain("Recent thread");
    expect(block).toContain("dinner is at 7 now, not 6");
    expect(block).toContain("and bring the good knife");
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
