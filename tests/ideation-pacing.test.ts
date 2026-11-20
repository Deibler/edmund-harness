import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents/store.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { mayRun } from "../src/ideation/ideator.ts";
import {
  HOLD_MS,
  MAX_BUILDS_PER_DAY,
  PAGE_GAP_DAYS,
  REPLY_WINDOW_MS,
  RETRY_GAP_DAYS,
  decayFor,
  jitterFor,
  nextLookMs,
  pageGate,
} from "../src/ideation/pacing.ts";
import { type Ideation, IdeationStore, newIdeationId } from "../src/ideation/store.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { ContactBook } from "../src/sessions/contacts.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-03T14:00:00-05:00");
const never = () => false;
const always = () => true;

/** A page row as pacing sees it. */
function page(over: Partial<Ideation> = {}): Ideation {
  return {
    id: newIdeationId(),
    sessionKey: "imessage:dm:+15550100001",
    thread: "the night sky",
    threadKey: "the night sky",
    title: "Meteor Log",
    pitch: "A chart.",
    why: "Asked often.",
    brief: "Build it.",
    evidence: [1, 2, 3],
    days: ["2026-10-24", "2026-10-27", "2026-11-01"],
    status: "ready",
    agentId: "agent_x",
    failReason: null,
    createdMs: T0 - HOUR,
    readyMs: T0 - HOUR + 600_000,
    announcedMs: T0 - HOUR + 600_000,
    deliveredMs: T0,
    firstOpenMs: null,
    opens: 0,
    url: "https://pages.example.com/i/x/",
    ...over,
  } as Ideation;
}

describe("the gap after a page reached them", () => {
  test("7 to 21 days, different after every page, the same on every check", () => {
    const gaps = Array.from({ length: 200 }, () => jitterFor(newIdeationId()));
    for (const j of gaps) {
      expect(j).toBeGreaterThanOrEqual(1);
      expect(j).toBeLessThan(3);
    }
    expect(new Set(gaps.map((j) => j.toFixed(3))).size).toBeGreaterThan(150);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(1.5);
    const id = newIdeationId();
    expect(jitterFor(id)).toBe(jitterFor(id));
  });

  test("blocked until delivered + 7 days × jitter, open from then on", () => {
    const p = page();
    const until = T0 + PAGE_GAP_DAYS * DAY * jitterFor(p.id); // answered: decay 1
    expect(pageGate([p], until - 60_000, always).ok).toBe(false);
    expect(pageGate([p], until + 60_000, always).ok).toBe(true);
  });

  test("a page nobody answered stretches the next gap; a run of them stretches it more", () => {
    const one = page();
    const at = (decay: number) => T0 + PAGE_GAP_DAYS * DAY * jitterFor(one.id) * decay;
    // Unanswered past the 36-hour window: 1.5×.
    expect(pageGate([one], at(1) + 60_000, never).ok).toBe(false);
    expect(pageGate([one], at(1.5) + 60_000, never).ok).toBe(true);
    // Two unanswered in a row: 2×; answered twice: 0.75×.
    expect(decayFor(["ignored", "ignored"])).toBe(2);
    expect(decayFor(["ignored", "ignored", "ignored", "ignored"])).toBe(3);
    expect(decayFor(["engaged", "engaged"])).toBe(0.75);
    expect(decayFor(["engaged", "ignored"])).toBe(1);
    expect(decayFor(["ignored", "engaged", "engaged"])).toBe(1.5);
  });

  test("the reply has to come within 36 hours of the page to count", () => {
    const p = page();
    let asked: [number, number] | null = null;
    pageGate([p], T0 + 30 * DAY, (from, to) => {
      asked = [from, to];
      return false;
    });
    expect(asked).toEqual([T0, T0 + REPLY_WINDOW_MS]);
  });
});

describe("one page at a time", () => {
  test("not while one is building or still waiting to be given", () => {
    const building = page({
      status: "building",
      readyMs: null,
      announcedMs: null,
      deliveredMs: null,
    });
    expect(pageGate([building], T0 + 60 * DAY, always)).toEqual({
      ok: false,
      why: "a page for them is still being built",
    });
    const held = page({ deliveredMs: null });
    expect(pageGate([held], T0 + 10 * DAY, always)).toEqual({
      ok: false,
      why: "a page for them is still waiting to be given",
    });
  });

  test("a held page let go after two weeks counts as ignored, and the gap runs from then", () => {
    const held = page({ deliveredMs: null });
    const letGo = (held.readyMs ?? 0) + HOLD_MS;
    const until = letGo + PAGE_GAP_DAYS * DAY * jitterFor(held.id) * 1.5;
    expect(pageGate([held], letGo + DAY, always).ok).toBe(false);
    expect(pageGate([held], until - 60_000, always).ok).toBe(false);
    expect(pageGate([held], until + 60_000, always).ok).toBe(true);
  });

  test("a build that went nowhere holds them a week from when it started", () => {
    for (const p of [
      page({ status: "failed", deliveredMs: null, announcedMs: null }),
      page({ status: "withdrawn", deliveredMs: null }),
      page({ deliveredMs: null, announcedMs: null }), // a dry run, never handed over
    ]) {
      const until = p.createdMs + RETRY_GAP_DAYS * DAY;
      expect(pageGate([p], until - 60_000, always).ok).toBe(false);
      expect(pageGate([p], until + 60_000, always).ok).toBe(true);
    }
  });

  test("only the newest page sets the gap, and two answered in a row shorten it", () => {
    const old = page({ createdMs: T0 - 40 * DAY, deliveredMs: T0 - 39 * DAY });
    const newer = page();
    const until = T0 + PAGE_GAP_DAYS * DAY * jitterFor(newer.id) * 0.75;
    expect(pageGate([old, newer], until - 60_000, always).ok).toBe(false);
    expect(pageGate([old, newer], until + 60_000, always).ok).toBe(true);
  });
});

describe("the ideator's next look", () => {
  test("after nothing to build: 2 to 6 days, stable; after anything else: 20 hours", () => {
    for (let n = 0; n < 50; n++) {
      const ranMs = T0 + n * 7_919_000;
      const next = nextLookMs({ ranMs, outcome: "none" }) ?? 0;
      expect(next - ranMs).toBeGreaterThanOrEqual(2 * DAY);
      expect(next - ranMs).toBeLessThan(6 * DAY);
      expect(nextLookMs({ ranMs, outcome: "none" })).toBe(next);
    }
    expect(nextLookMs({ ranMs: T0, outcome: "skipped" })).toBe(T0 + 20 * HOUR);
    expect(nextLookMs(null)).toBeNull();
  });
});

describe("mayRun, against a real chat.db and ideations.db", () => {
  const SAM = "+15550100001";
  const KEY = `imessage:dm:${SAM}`;
  const appleNs = (ms: number) => (ms - 978_307_200_000) * 1_000_000;

  function world() {
    const dataDir = mkdtempSync(join(tmpdir(), "ideation-pacing-"));
    const chatPath = join(dataDir, "chat.db");
    const w = new Database(chatPath);
    w.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, date INTEGER,
        is_from_me INTEGER DEFAULT 0);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      INSERT INTO chat VALUES (1, 'any;-;${SAM}', '${SAM}', 45);
      INSERT INTO handle VALUES (1, '${SAM}');
      INSERT INTO chat_handle_join VALUES (1, 1);
    `);
    let row = 0;
    const theySay = (atMs: number) => {
      row++;
      w.query("INSERT INTO message (ROWID, text, date, is_from_me) VALUES (?, 'ok', ?, 0)").run(
        row,
        appleNs(atMs),
      );
      w.query("INSERT INTO chat_message_join VALUES (1, ?)").run(row);
    };
    const store = new IdeationStore(dataDir);
    const given = (sessionKey = KEY, atMs = T0) => {
      const id = newIdeationId();
      store.create({
        id,
        sessionKey,
        thread: "the night sky",
        threadKey: "the night sky",
        title: "Meteor Log",
        pitch: "A chart.",
        why: "Asked.",
        brief: "Build it.",
        evidence: [1],
        days: ["2026-10-24"],
        createdMs: atMs - HOUR,
      });
      store.markReady(id, atMs - 50 * 60_000, `https://pages.example.com/i/${id}/`);
      store.markAnnounced(id, atMs - 50 * 60_000);
      store.markDelivered(id, atMs);
      return id;
    };
    const deps = {
      config: ConfigSchema.parse({
        self: { handles: [] },
        allowlist: {},
        identity: {},
        paths: { data_dir: dataDir, chat_db: chatPath },
        security: { model_host_access: "full" },
        ideation: { enabled: true, people: ["*"] },
      }),
      chatDb: new ChatDb(chatPath),
      contacts: new ContactBook([]),
      store,
      agents: new AgentStore(dataDir),
    };
    return { deps, store, given, theySay };
  }

  test("a reply in chat.db within 36 hours keeps the gap; silence stretches it", () => {
    const answered = world();
    const id = answered.given();
    answered.theySay(T0 + 3 * HOUR);
    const silent = world();
    const id2 = silent.given();
    // Find a moment past the answered gap but inside the 1.5× one, for both ids.
    const a = T0 + PAGE_GAP_DAYS * DAY * jitterFor(id);
    const b = T0 + PAGE_GAP_DAYS * DAY * jitterFor(id2);
    expect(mayRun(answered.deps, KEY, a + 60_000).ok).toBe(true);
    expect(mayRun(silent.deps, KEY, b + 60_000).ok).toBe(false);
    expect(
      mayRun(silent.deps, KEY, T0 + PAGE_GAP_DAYS * DAY * jitterFor(id2) * 1.5 + 60_000).ok,
    ).toBe(true);
  });

  test("a reply two days after the page does not count as answering it", () => {
    const w = world();
    const id = w.given();
    w.theySay(T0 + 48 * HOUR);
    const a = T0 + PAGE_GAP_DAYS * DAY * jitterFor(id);
    expect(mayRun(w.deps, KEY, a + 60_000).ok).toBe(false);
  });

  test(`no more than ${MAX_BUILDS_PER_DAY} pages started in a day, for anyone`, () => {
    const w = world();
    w.given("imessage:dm:+15550100002", T0 - 2 * HOUR);
    w.given("imessage:dm:+15550100003", T0 - 3 * HOUR);
    const r = mayRun(w.deps, KEY, T0);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.why).toContain("already started in the last day");
    expect(mayRun(w.deps, KEY, T0 + DAY).ok).toBe(true);
  });
});
