import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents/store.ts";
import { ConfigSchema } from "../src/config/config.ts";
import type { CronJob } from "../src/cron/types.ts";
import { checkActiveHours } from "../src/ghost/budget.ts";
import { type BrownNosePrefs, DEFAULT_ACTIVE_HOURS_DM } from "../src/ghost/prefs.ts";
import { IdeationObserver } from "../src/ideation/observer.ts";
import { HOLD_MS } from "../src/ideation/pacing.ts";
import {
  FALLBACK_WINDOW_MS,
  IDEATION_READY_HEAD,
  SOON_WINDOW_MS,
  ideationReadyMessage,
  pageStillToGive,
  planDelivery,
} from "../src/ideation/settle.ts";
import { type Ideation, IdeationStore, newIdeationId } from "../src/ideation/store.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { fireJob } from "../src/scheduler/fire.ts";
import { ContactBook } from "../src/sessions/contacts.ts";

const SAM = "+15550100001";
const KEY = `imessage:dm:${SAM}`;
const HOURS = { activeHours: DEFAULT_ACTIVE_HOURS_DM, timezone: "America/New_York" };
const AFTERNOON = Date.parse("2026-11-03T14:00:00-05:00");
const MIN = 60_000;
const appleNs = (ms: number) => (ms - 978_307_200_000) * 1_000_000;
const inHours = (ms: number) => checkActiveHours(HOURS as BrownNosePrefs, ms).ok;

/** Small deterministic PRNG (mulberry32), so a failure reproduces. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("planDelivery", () => {
  test("not one fixed lag: soon and held both happen, spread out, always in their hours", () => {
    const random = seeded(7);
    const plans = Array.from({ length: 300 }, () =>
      planDelivery({ hours: HOURS, nowMs: AFTERNOON, lastInboundMs: null, random }),
    );
    const soon = plans.filter((p) => p.kind === "soon");
    const held = plans.filter((p) => p.kind === "held");
    expect(soon.length / plans.length).toBeGreaterThan(0.2);
    expect(soon.length / plans.length).toBeLessThan(0.47);
    for (const p of soon) {
      expect(p.atMs).toBeGreaterThanOrEqual(AFTERNOON + SOON_WINDOW_MS[0]);
      expect(p.atMs).toBeLessThanOrEqual(AFTERNOON + SOON_WINDOW_MS[1]);
    }
    for (const p of held) {
      expect(p.atMs).toBeGreaterThanOrEqual(AFTERNOON + FALLBACK_WINDOW_MS[0]);
      expect(p.atMs).toBeLessThanOrEqual(AFTERNOON + FALLBACK_WINDOW_MS[1]);
    }
    for (const p of plans) expect(inHours(p.atMs)).toBe(true);
    // A fixed delay would give one value; a rhythm would give a handful.
    expect(new Set(plans.map((p) => p.atMs)).size).toBeGreaterThan(250);
    const soonSpread = Math.max(...soon.map((p) => p.atMs)) - Math.min(...soon.map((p) => p.atMs));
    expect(soonSpread).toBeGreaterThan(60 * MIN);
  });

  test("never soon while they are mid-conversation, whatever the draw", () => {
    for (const r of [0, 0.1, 0.3, 0.9]) {
      const p = planDelivery({
        hours: HOURS,
        nowMs: AFTERNOON,
        lastInboundMs: AFTERNOON - 3 * MIN,
        random: () => r,
      });
      expect(p.kind).toBe("held");
    }
    // Twenty minutes after their last message is no longer mid-conversation.
    const later = planDelivery({
      hours: HOURS,
      nowMs: AFTERNOON,
      lastInboundMs: AFTERNOON - 20 * MIN,
      random: () => 0,
    });
    expect(later.kind).toBe("soon");
  });

  test("a soon draw just before their hours end is held instead of sent late", () => {
    const late = Date.parse("2026-11-03T20:58:00-05:00");
    const p = planDelivery({ hours: HOURS, nowMs: late, lastInboundMs: null, random: () => 0 });
    expect(p.kind).toBe("held");
    expect(inHours(p.atMs)).toBe(true);
  });

  test("someone with no hours set gets the default hours, not 3 a.m.", () => {
    const random = seeded(3);
    for (let n = 0; n < 50; n++) {
      const p = planDelivery({
        hours: { activeHours: [], timezone: "America/New_York" },
        nowMs: AFTERNOON,
        lastInboundMs: null,
        random,
      });
      expect(inHours(p.atMs)).toBe(true);
    }
  });
});

// ─── a chat.db with Sam's one-to-one chat, and pages in ideations.db ────────

function world() {
  const dataDir = mkdtempSync(join(tmpdir(), "ideation-timing-"));
  const chatPath = join(dataDir, "chat.db");
  const w = new Database(chatPath);
  w.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      date INTEGER, is_from_me INTEGER DEFAULT 0, handle_id INTEGER DEFAULT 0,
      associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat VALUES (1, 'any;-;${SAM}', '${SAM}', 45);
    INSERT INTO handle VALUES (1, '${SAM}');
    INSERT INTO chat_handle_join VALUES (1, 1);
  `);
  let row = 100;
  const say = (text: string, atMs: number, fromMe: boolean) => {
    row++;
    w.query(
      "INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?, ?, ?, ?, ?, 1)",
    ).run(row, `g${row}`, text, appleNs(atMs), fromMe ? 1 : 0);
    w.query("INSERT INTO chat_message_join VALUES (1, ?)").run(row);
  };
  const store = new IdeationStore(dataDir);
  const page = (opts: { sessionKey?: string; announced?: boolean; readyMs?: number } = {}) => {
    const id = newIdeationId();
    store.create({
      id,
      sessionKey: opts.sessionKey ?? KEY,
      thread: "the night sky",
      threadKey: "the night sky",
      title: "Meteor Log",
      pitch: "Every night's count on one chart.",
      why: "Asked on five days.",
      brief: "Build it.",
      evidence: [1, 2, 3],
      days: ["2026-10-24", "2026-10-27", "2026-11-01"],
      createdMs: (opts.readyMs ?? AFTERNOON) - 10 * MIN,
    });
    store.markReady(id, opts.readyMs ?? AFTERNOON, `https://pages.example.com/i/${id}/`);
    if (opts.announced !== false) store.markAnnounced(id, opts.readyMs ?? AFTERNOON);
    return store.get(id) as Ideation;
  };
  const config = (enabled = true) =>
    ConfigSchema.parse({
      self: { handles: [] },
      allowlist: {},
      identity: {},
      paths: { data_dir: dataDir, chat_db: chatPath },
      security: { model_host_access: "full" },
      ideation: { enabled, people: ["*"] },
    });
  const chatDb = new ChatDb(chatPath);
  const observer = (enabled = true) =>
    new IdeationObserver({
      config: config(enabled),
      chatDb,
      contacts: new ContactBook([]),
      store,
      agents: new AgentStore(dataDir),
    });
  return { dataDir, store, page, say, config, chatDb, observer };
}

describe("a held page rides on their next messages", () => {
  test("offered until a reply carries its link, then never again", () => {
    const w = world();
    const p = w.page();
    const obs = w.observer();
    const first = obs.heldPageBlock(KEY, AFTERNOON + 3 * 3_600_000);
    expect(first?.id).toBe(p.id);
    expect(first?.block).toContain(`https://pages.example.com/i/${p.id}/`);
    expect(first?.block).toContain("say nothing about it");
    // Edmund gives it in his reply; the next message finds it in chat.db.
    w.say(`made you this\nhttps://pages.example.com/i/${p.id}/`, AFTERNOON + 3 * 3_600_000, true);
    expect(obs.heldPageBlock(KEY, AFTERNOON + 4 * 3_600_000)).toBeNull();
    expect(w.store.get(p.id)?.deliveredMs).not.toBeNull();
  });

  test("not a page that was never handed to Edmund, someone else's, a withdrawn one, or a stale one", () => {
    const w = world();
    const obs = w.observer();
    w.page({ announced: false }); // a dry run: built, never handed over
    w.page({ sessionKey: "imessage:dm:+15550100002" });
    const gone = w.page();
    w.store.withdraw(gone.id, "taken down");
    expect(obs.heldPageBlock(KEY, AFTERNOON + MIN)).toBeNull();
    const old = w.page({ readyMs: AFTERNOON - HOLD_MS - MIN });
    expect(obs.heldPageBlock(KEY, AFTERNOON)).toBeNull();
    expect(w.store.get(old.id)?.deliveredMs).toBeNull();
  });

  test("nothing when ideation is switched off", () => {
    const w = world();
    w.page();
    expect(w.observer(false).heldPageBlock(KEY, AFTERNOON + MIN)).toBeNull();
    expect(w.observer(true).heldPageBlock(KEY, AFTERNOON + MIN)).not.toBeNull();
  });

  test("a link Edmund sent before the page was handed to him does not count", () => {
    const w = world();
    const p = w.page();
    w.say(`https://pages.example.com/i/${p.id}/`, AFTERNOON - MIN, true);
    expect(w.observer().heldPageBlock(KEY, AFTERNOON + MIN)?.id).toBe(p.id);
  });
});

describe("the scheduled message is only a fallback", () => {
  const event = (p: Ideation) => ideationReadyMessage(p, "Sam", "held");

  test("still to give until the link is in chat.db; then spent", () => {
    const w = world();
    const p = w.page();
    expect(pageStillToGive(w.config(), KEY, event(p), w.chatDb)).toBe(true);
    w.say(`https://pages.example.com/i/${p.id}/`, AFTERNOON + 2 * 3_600_000, true);
    expect(pageStillToGive(w.config(), KEY, event(p), w.chatDb)).toBe(false);
  });

  test("spent when the page was taken down; anything that is not a page fires as before", () => {
    const w = world();
    const p = w.page();
    w.store.withdraw(p.id, "taken down");
    expect(pageStillToGive(w.config(), KEY, event(p), w.chatDb)).toBe(false);
    expect(pageStillToGive(w.config(), KEY, "Self-poke: check the oven", w.chatDb)).toBe(true);
  });

  test("fireJob skips a page already given, before it touches the session", async () => {
    const w = world();
    const given = w.page();
    const owed = w.page({ sessionKey: KEY });
    w.say(`https://pages.example.com/i/${given.id}/`, AFTERNOON + MIN, true);
    const looked: string[] = [];
    const state = {
      getSession: (k: string) => {
        looked.push(k);
        return null; // "no session record": fireJob stops there either way
      },
    };
    const job = (p: Ideation): CronJob =>
      ({
        id: `job-${p.id}`,
        sessionKey: KEY,
        systemEvent: event(p),
        schedule: { kind: "once", atMs: AFTERNOON },
        nextFireMs: AFTERNOON,
        gracePeriodMs: null,
      }) as unknown as CronJob;
    const unused = {} as never;
    const run = (p: Ideation) =>
      fireJob(job(p), w.config(), state as never, unused, unused, unused, unused, unused, unused, {
        chatDb: w.chatDb,
      });
    await run(given);
    expect(looked).toEqual([]);
    await run(owed);
    expect(looked).toEqual([KEY]);
    expect(event(owed)).toStartWith(IDEATION_READY_HEAD);
  });
});
