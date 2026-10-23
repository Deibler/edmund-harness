/**
 * A fire labelled `error` or `vetoed` whose message reached the chat anyway
 * (a timed-out send that flushed, a run that sent through a tool) must pace
 * the next one everywhere a fire is gated: the ghost tick, the queue's 48h
 * spacing and the send-time recheck. When Edmund wrote first in the fire's
 * window, the correction is saved, so the open-thread gate holds and the
 * outcome sweep scores it.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import { landingIn } from "../src/ghost/landed.ts";
import { GhostObserver } from "../src/ghost/observer.ts";
import { GhostPrefsStore, autoEnrollSessions } from "../src/ghost/prefs.ts";
import { runGhostTick } from "../src/ghost/think.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { fireTimeGates } from "../src/proactive/fire.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import type { StateStore } from "../src/sessions/store.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const MIN = 60_000;
const GUID = "any;+;chat5550043";
const KEY = `imessage:group:${GUID}` as SessionKey;
const NOW = Date.now();
// Fire A: Edmund's message flushed 5 minutes in, nobody else wrote first.
const FIRED_A = NOW - 20 * MIN;
// Window B (2 days back): the person wrote, then Edmund answered.
const FIRED_B = NOW - 2 * 24 * 60 * MIN;
// Window C (3 days back): only the person wrote; Edmund wrote two hours on.
const FIRED_C = NOW - 3 * 24 * 60 * MIN;

const db = emptyChatDb();
{
  const w = new Database(db.path);
  w.exec(`INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, '${GUID}', 'x')`);
  let row = 0;
  const msg = (atMs: number, fromMe: 0 | 1) => {
    row++;
    w.query(
      "INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date) VALUES (?, ?, 'x', 0, ?, (? - 978307200000) * 1000000)",
    ).run(row, `G${row}`, fromMe, atMs);
    w.exec(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ${row})`);
  };
  msg(FIRED_A + 5 * MIN, 1);
  msg(FIRED_B + 2 * MIN, 0);
  msg(FIRED_B + 4 * MIN, 1);
  msg(FIRED_C + 3 * MIN, 0);
  msg(FIRED_C + 120 * MIN, 1);
  w.close();
}
const chatDb = new ChatDb(db.path);
afterAll(() => {
  chatDb.close();
  db.cleanup();
});

const config = ConfigSchema.parse({
  self: { handles: [] },
  allowlist: {},
  identity: {},
  brown_nose: { enabled: true },
});
const contacts = {} as ContactBook;

let dir: string;
let prefs: GhostPrefsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ghost-landing-"));
  prefs = new GhostPrefsStore(dir);
  autoEnrollSessions(prefs, [{ sessionKey: KEY, isGroup: true }], {
    dmEnabled: true,
    groupEnabled: true,
    timezone: "UTC",
    weeklyCap: 5,
  });
});
afterEach(() => {
  prefs.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Fire A as the send path left it: recorded, then stamped `error`. */
function erroredFireA(): number {
  const id = prefs.recordFire({ sessionKey: KEY, firedAtMs: FIRED_A, brief: "b", tags: [] });
  prefs.recordOutcome(id, "error");
  return id;
}

describe("what reached the chat in a fire's window", () => {
  test("Edmund first, someone else first, only them, nothing readable", () => {
    const deps = { chatDb, contacts };
    expect(landingIn(KEY, deps, FIRED_A, FIRED_A + 30 * MIN)).toBe("unprompted");
    expect(landingIn(KEY, deps, FIRED_B, FIRED_B + 30 * MIN)).toBe("answering");
    // The person's own message is not Edmund's.
    expect(landingIn(KEY, deps, FIRED_C, FIRED_C + 30 * MIN)).toBe("none");
    // A session with no chat row never received anything.
    const noChat = {
      chatDb: { query: () => ({ all: () => [], get: () => undefined }) } as unknown as ChatDb,
      contacts: { allKnownHandles: () => [], canon: (h: string) => h } as unknown as ContactBook,
    };
    expect(landingIn("imessage:dm:+15550100044" as SessionKey, noChat, FIRED_A, NOW)).toBe("none");
    // The window is the fire's run plus a late flush, not hours.
    expect(landingIn(KEY, deps, FIRED_C + 10 * MIN, FIRED_C + 40 * MIN)).toBe("none");
  });
});

describe("a landed fire paces the next one wherever fires are gated", () => {
  test("the ghost tick: cooldown holds, and the correction is saved", async () => {
    erroredFireA();
    const dec = await runGhostTick(
      { sessionKey: KEY, nowMs: NOW, bypassActiveHours: true, dryRun: true },
      { config, chatDb, contacts, prefs },
    );
    expect(dec.act).toBe(false);
    if (!dec.act) expect(dec.reason).toStartWith("cooldown:");
    const [row] = prefs.recentFires(KEY, 1);
    expect(row).toMatchObject({ delivered: true, outcome: null });
    expect(prefs.pendingOutcomes(10).map((f) => f.firedAtMs)).toContain(FIRED_A);
  });

  test("the queue's 48h spacing sees it", () => {
    erroredFireA();
    const observer = new GhostObserver({
      config,
      chatDb,
      contacts,
      prefs,
      crons: {} as never,
      state: { getSession: () => null } as unknown as StateStore,
    });
    expect(observer.contactFires(KEY, 1).map((f) => f.firedAtMs)).toEqual([FIRED_A]);
  });

  test("the send-time recheck holds a second brief behind the open thread", () => {
    erroredFireA();
    const gate = fireTimeGates({
      sessionKey: KEY,
      sessionPrefs: prefs.get(KEY)!,
      prefs,
      config,
      lastInboundMs: 0,
      nowMs: NOW,
      landing: { chatDb, contacts },
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("outstanding proactive thread");
  });

  test("a message two hours after a vetoed fire is not that fire", () => {
    const id = prefs.recordFire({ sessionKey: KEY, firedAtMs: FIRED_C, brief: "b", tags: [] });
    prefs.recordOutcome(id, "vetoed");
    const observer = new GhostObserver({
      config,
      chatDb,
      contacts,
      prefs,
      crons: {} as never,
      state: { getSession: () => null } as unknown as StateStore,
    });
    expect(observer.contactFires(KEY, 1)).toEqual([]);
  });

  test("an answer to the person counts for pacing but is not saved as the fire", () => {
    const id = prefs.recordFire({ sessionKey: KEY, firedAtMs: FIRED_B, brief: "b", tags: [] });
    prefs.recordOutcome(id, "vetoed");
    const observer = new GhostObserver({
      config,
      chatDb,
      contacts,
      prefs,
      crons: {} as never,
      state: { getSession: () => null } as unknown as StateStore,
    });
    expect(observer.contactFires(KEY, 1).map((f) => f.firedAtMs)).toEqual([FIRED_B]);
    expect(prefs.recentFires(KEY, 1)[0]).toMatchObject({ delivered: false, outcome: "vetoed" });
  });
});
