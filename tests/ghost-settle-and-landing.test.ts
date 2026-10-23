/**
 * Review follow-ups to the ghost attention change (2026-10-23):
 *  - the settled tick, exercised on the clock rather than by reading source;
 *  - excerpts kept dated history but dropped undated standing state (the
 *    ghost's "Watching" and "not hooks" sections, undated open items);
 *  - fire labels come from what a send reported, so a vetoed or errored
 *    fire is checked against what actually reached the chat before it
 *    stops pacing the next one;
 *  - a group's quiet is measured from its own newest message, not from
 *    Edmund's last turn.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { ConfigSchema } from "../src/config/config.ts";
import { isContact } from "../src/ghost/budget.ts";
import { excerptNotes, excerptPersonFile } from "../src/ghost/excerpt.ts";
import { FIRE_LANDING_WINDOW_MS, withLandingEvidence } from "../src/ghost/landed.ts";
import { GhostObserver, SETTLE_MS } from "../src/ghost/observer.ts";
import type { BrownNosePrefs, FireRecord, GhostPrefsStore } from "../src/ghost/prefs.ts";
import { type GhostSmsHistory, buildPreScreenSystem } from "../src/ghost/think.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { HistoryLine } from "../src/imessage/history.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import type { StateStore } from "../src/sessions/store.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const MIN = 60_000;
const config = ConfigSchema.parse({
  self: { handles: [] },
  allowlist: {},
  identity: {},
  brown_nose: { enabled: true },
});
const allDay: BrownNosePrefs = {
  sessionKey: "sms:group:CH00000000000000000000000000000041",
  enabled: true,
  activeHours: (["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map((dow) => ({
    dow,
    start: "00:00",
    end: "24:00",
  })),
  timezone: "UTC",
  weeklyCap: 3,
  cooldownMultiplier: 1,
  focusSuggestions: [],
  disabledReason: null,
  disabledAtMs: null,
  updatedAtMs: 0,
};

function line(atMs: number, fromMe: boolean): HistoryLine {
  return {
    rowId: atMs,
    timestampMs: atMs,
    fromHandle: fromMe ? "" : "+15550100041",
    fromMe,
    text: "x",
    isTapback: false,
    tapbackTargetIsMe: false,
    tapbackTargetHandle: "",
  };
}

describe("the settled tick on the clock", () => {
  const KEY = allDay.sessionKey as SessionKey;
  let chatLastMs = 0;
  let replyAtMs = 0;
  let ticks: string[] = [];
  let observer: GhostObserver;

  beforeEach(() => {
    jest.useFakeTimers();
    spyOn(Math, "random").mockReturnValue(0);
    chatLastMs = Date.now();
    replyAtMs = chatLastMs;
    ticks = [];
    observer = new GhostObserver({
      config,
      chatDb: {} as ChatDb,
      contacts: {} as ContactBook,
      prefs: { get: () => allDay } as unknown as GhostPrefsStore,
      crons: {} as never,
      // Edmund's last turn: the reply that armed the tick.
      state: {
        getSession: () => ({ lastInboundMs: 0, lastOutboundMs: replyAtMs }),
      } as unknown as StateStore,
      // The group keeps talking without Edmund: only the chat sees it.
      sms: { history: () => [line(chatLastMs, false)] } as GhostSmsHistory,
    });
    (
      observer as unknown as { runReactiveTick: (k: string, r: string) => Promise<void> }
    ).runReactiveTick = async (_k, reason) => {
      ticks.push(reason);
    };
  });
  afterEach(() => {
    observer.stop();
    jest.useRealTimers();
    (Math.random as unknown as { mockRestore: () => void }).mockRestore();
  });

  test("waits out the chatter, then ticks once", () => {
    observer.onMainReplied(KEY);
    jest.advanceTimersByTime(20 * MIN);
    chatLastMs = Date.now(); // a member writes; Edmund is not addressed
    jest.advanceTimersByTime(10 * MIN); // the first timer fires 10 min into the quiet
    expect(ticks).toEqual([]);
    jest.advanceTimersByTime(SETTLE_MS - 10 * MIN - MIN);
    expect(ticks).toEqual([]);
    jest.advanceTimersByTime(2 * MIN);
    expect(ticks).toEqual(["settled"]);
    jest.advanceTimersByTime(3 * 60 * MIN);
    expect(ticks).toEqual(["settled"]);
  });

  test("a quiet chat ticks when the settle time is up", () => {
    observer.onMainReplied(KEY);
    jest.advanceTimersByTime(SETTLE_MS - MIN);
    expect(ticks).toEqual([]);
    jest.advanceTimersByTime(2 * MIN);
    expect(ticks).toEqual(["settled"]);
  });

  test("nothing ticks after stop()", () => {
    observer.onMainReplied(KEY);
    observer.stop();
    jest.advanceTimersByTime(4 * 60 * MIN);
    expect(ticks).toEqual([]);
  });
});

describe("excerpts keep standing state", () => {
  const openItems = [
    "# Sample Person",
    "## Who They Are",
    ...Array.from({ length: 40 }, (_, i) => `- trait ${i} ${"y".repeat(60)}`),
    "## Open Items",
    "_(live threads)_",
    ...Array.from({ length: 6 }, (_, i) => `- undated item ${i}: still owes a reply`),
    ...Array.from(
      { length: 40 },
      (_, i) =>
        `- **2026-09-${String((i % 28) + 1).padStart(2, "0")}** — dated item ${i} ${"z".repeat(50)}`,
    ),
    "- **2026-10-21** — newest dated item",
  ].join("\n");

  test("every undated open item survives next to the newest dated one", () => {
    const ex = excerptPersonFile(openItems, 3000);
    for (let i = 0; i < 6; i++) expect(ex).toContain(`undated item ${i}: still owes a reply`);
    expect(ex).toContain("newest dated item");
    expect(ex).toContain("## Who They Are");
  });

  const notes = [
    "# Current Notes",
    "## Watching",
    "- the lake trip forecast",
    "## Not hooks (handled elsewhere)",
    "- the dentist reminder is a cron, leave it",
    ...Array.from(
      { length: 20 },
      (_, i) => `## 2026-09-${String(i + 1).padStart(2, "0")} update\n${"note ".repeat(180)}`,
    ),
    "## 2026-10-22 update",
    "latest: waiting on photos",
    "## Next tick guidance",
    "- check whether the photos arrived",
  ].join("\n");

  test("undated note sections are kept ahead of dated history", () => {
    const ex = excerptNotes(notes, 3000);
    for (const s of [
      "the lake trip forecast",
      "the dentist reminder is a cron, leave it",
      "check whether the photos arrived",
      "# Current Notes",
      "latest: waiting on photos",
    ]) {
      expect(ex).toContain(s);
    }
  });

  test("the entry at the boundary is cut, not skipped", () => {
    expect(excerptNotes(notes, 3000).length).toBeGreaterThan(2700);
  });

  test("a small share never overflows on a long heading and the omitted marker", () => {
    const tight = [
      "# P",
      `## Open Items — everything still owed, promised or waiting ${"on someone ".repeat(4)}`,
      ...Array.from(
        { length: 30 },
        (_, i) =>
          `- **2026-10-${String((i % 28) + 1).padStart(2, "0")}** — item ${i} ${"w".repeat(40)}`,
      ),
      "## Who They Are",
      ...Array.from({ length: 20 }, (_, i) => `- fact ${i} ${"v".repeat(40)}`),
    ].join("\n");
    for (let budget = 150; budget <= 1200; budget += 25) {
      expect(excerptPersonFile(tight, budget).length).toBeLessThanOrEqual(budget);
    }
  });

  test("no excerpt is longer than its budget", () => {
    for (const budget of [1500, 3000, 6000]) {
      expect(excerptPersonFile(openItems, budget).length).toBeLessThanOrEqual(budget);
      expect(excerptNotes(notes, budget).length).toBeLessThanOrEqual(budget);
    }
  });
});

describe("the pre-screen's copy of GHOST.md", () => {
  test("loses the lines about the decision call, keeps the rest of the rules", () => {
    const ghost = [
      "# Ghost",
      "## Hard rules",
      "",
      "1. **Always finish with one `submit_decision` call.** Printed text is",
      "   ignored; a tick that never calls the tool is a wasted tick.",
      "2. **Doubt resolves by intensity.** At 7 and above, when in",
      "   doubt act.",
    ].join("\n");
    const sys = buildPreScreenSystem(6, ghost);
    expect(sys).toContain("Doubt resolves by intensity");
    expect(sys).toContain("doubt act.");
    expect(sys).not.toContain("Printed text is");
    expect(sys).not.toContain("wasted tick");
  });
});

describe("a fire's label is checked against what reached the chat", () => {
  const GROUP = "imessage:group:any;+;chat5550041" as SessionKey;
  const FIRED = Date.parse("2026-10-20T15:00:00Z");
  const NOW = FIRED + 3 * 3_600_000;
  const db = emptyChatDb();
  {
    const w = new Database(db.path);
    w.exec("INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, 'any;+;chat5550041', 'x')");
    const sent = (row: number, atMs: number) => {
      w.query(
        "INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date) VALUES (?, ?, 'x', 0, 1, (? - 978307200000) * 1000000)",
      ).run(row, `G${row}`, atMs);
      w.exec(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ${row})`);
    };
    sent(1, FIRED + 5 * MIN); // the fire's message, flushed after a reported failure
    sent(2, FIRED + 2 * FIRE_LANDING_WINDOW_MS + 10 * MIN); // well after the window
    w.close();
  }
  const chatDb = new ChatDb(db.path);
  afterAll(() => {
    chatDb.close();
    db.cleanup();
  });
  const fire = (at: number, outcome: FireRecord["outcome"]): FireRecord => ({
    id: 1,
    sessionKey: GROUP,
    firedAtMs: at,
    brief: "b",
    tags: [],
    outcome,
    outcomeAtMs: null,
    reactionGlyph: null,
    delivered: false,
  });
  const deps = { chatDb, contacts: {} as ContactBook };

  test("an errored fire whose message landed paces the next one", () => {
    const [f] = withLandingEvidence([fire(FIRED, "error")], GROUP, deps, NOW);
    expect(f!.delivered).toBe(true);
    expect(isContact(f!, NOW)).toBe(true);
  });

  test("a vetoed fire with nothing sent in its window does not", () => {
    const later = FIRED + FIRE_LANDING_WINDOW_MS + MIN;
    const [f] = withLandingEvidence([fire(later, "vetoed")], GROUP, deps, NOW);
    expect(isContact(f!, NOW)).toBe(false);
  });

  test("when the chat can't be read, the fire counts", () => {
    const broken = {
      chatDb: new Proxy(
        {},
        {
          get() {
            throw new Error("chat.db unavailable");
          },
        },
      ) as unknown as ChatDb,
      contacts: {} as ContactBook,
    };
    const [a] = withLandingEvidence([fire(FIRED, "vetoed")], GROUP, broken, NOW);
    expect(isContact(a!, NOW)).toBe(true);
    const sms = "sms:dm:+15550100042" as SessionKey;
    const [b] = withLandingEvidence([fire(FIRED, "error")], sms, broken, NOW);
    expect(isContact(b!, NOW)).toBe(true);
  });
});
