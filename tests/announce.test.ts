import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EligibilityConfig, checkEligibility } from "../src/announce/eligibility.ts";
import { PORTAL_TABS, normalizeLink } from "../src/announce/links.ts";
import { type OfferDeps, confirmDelivery, pickOffer, renderBlock } from "../src/announce/offer.ts";
import { AnnouncementStore } from "../src/announce/store.ts";
import { loadConfig } from "../src/config/config.ts";
import type { Config } from "../src/config/config.ts";
import type { ChatDb } from "../src/imessage/db.ts";
import { ContactBook } from "../src/sessions/contacts.ts";

/**
 * Announcements.
 *
 * The risk here is not a crash, it is a tonal one: an unprompted product
 * pitch to someone who texts twice a month reads as spam from a friend, and
 * it cannot be taken back. So most of these tests are about NOT telling
 * someone — every rule fails closed, and each one is exercised on its own.
 */

const DAY = 86_400_000;
const REGULAR = "+15550001111";
const OCCASIONAL = "+15550002222";

const contacts = new ContactBook([
  { name: "Regular", handles: [REGULAR] },
  { name: "Occasional", handles: [OCCASIONAL] },
]);

/**
 * chat.db stand-in. `activeDays` and `tenureDays` are the only queries, and
 * they are told apart by which column they select.
 */
function fakeChatDb(byHandle: Record<string, { days: number; tenureDays: number }>): ChatDb {
  return {
    query: (sql: string) => ({
      get: (handlesJson: string) => {
        const handles = JSON.parse(handlesJson) as string[];
        const hit = handles.map((h) => byHandle[h]).find(Boolean);
        if (!hit) return sql.includes("MIN(m.date)") ? { first: null } : { days: 0 };
        if (sql.includes("MIN(m.date)")) {
          const firstMs = Date.now() - hit.tenureDays * DAY;
          return { first: (firstMs - 978_307_200_000) * 1_000_000 };
        }
        return { days: hit.days };
      },
      all: () => [],
    }),
  } as unknown as ChatDb;
}

const chatDb = fakeChatDb({
  [REGULAR]: { days: 22, tenureDays: 300 },
  [OCCASIONAL]: { days: 2, tenureDays: 300 },
});

const cfg: EligibilityConfig = {
  window_days: 30,
  min_active_days: 12,
  min_tenure_days: 21,
  cooldown_days: 14,
  max_offers: 3,
};

function check(sessionKey: string, over: Partial<Parameters<typeof checkEligibility>[0]> = {}) {
  return checkEligibility({
    sessionKey,
    chatDb,
    contacts,
    guestTier: null,
    lastOfferMs: 0,
    config: cfg,
    ...over,
  });
}

describe("who may be told", () => {
  test("a regular qualifies", () => {
    const result = check(`imessage:dm:${REGULAR}`);
    expect(result.eligible).toBe(true);
    if (!result.eligible) throw new Error("unreachable");
    expect(result.activeDays).toBe(22);
  });

  test("the once-a-fortnight texter never qualifies", () => {
    // The case the whole feature must not get wrong.
    const result = check(`imessage:dm:${OCCASIONAL}`);
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reason).toContain("wrote on 2 of the last 30 days");
  });

  test("groups are never eligible, however active they are", () => {
    // A group reaches whoever is in it, including people who did not clear
    // the bar individually. There is no version of this that is safe.
    const result = check("imessage:group:iMessage;+;chat-very-busy");
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reason).toContain("not a direct message");
  });

  test("guests are never eligible", () => {
    const result = check(`imessage:dm:${REGULAR}`, { guestTier: "keyed-guest" });
    expect(result.eligible).toBe(false);
  });

  test("a brand-new regular waits out the tenure floor", () => {
    // Someone can be very chatty in their first week without that being a
    // relationship where a capability pitch is welcome.
    const fresh = fakeChatDb({ [REGULAR]: { days: 20, tenureDays: 5 } });
    const result = check(`imessage:dm:${REGULAR}`, { chatDb: fresh });
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reason).toContain("only known them 5d");
  });

  test("someone told recently is left alone", () => {
    const result = check(`imessage:dm:${REGULAR}`, { lastOfferMs: Date.now() - 3 * DAY });
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reason).toContain("cooldown");
  });

  test("the cooldown expires", () => {
    expect(check(`imessage:dm:${REGULAR}`, { lastOfferMs: Date.now() - 20 * DAY }).eligible).toBe(
      true,
    );
  });

  test("an announcement may raise its own floor but the global one still binds", () => {
    // Override is a floor-RAISER, not a bypass: it selects a narrower
    // audience for a niche capability, never a wider one.
    expect(check(`imessage:dm:${REGULAR}`, { minActiveDaysOverride: 25 }).eligible).toBe(false);
    expect(check(`imessage:dm:${OCCASIONAL}`, { minActiveDaysOverride: 1 }).eligible).toBe(true);
  });
});

describe("offering and confirming", () => {
  let dir: string;
  let store: AnnouncementStore;
  let config: Config;
  let deps: OfferDeps;
  const session = `imessage:dm:${REGULAR}`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "announce-"));
    store = new AnnouncementStore(dir);
    config = loadConfig(join(import.meta.dir, "..", "config.example.toml"));
    // The portal secret is written into the temp dir on first use, so tests
    // never read or create the real one.
    config = { ...config, paths: { ...config.paths, data_dir: dir } };
    deps = { config, dataDir: dir, chatDb, contacts, guestTier: null, store };
    store.add({
      id: "ann_1",
      title: "Skills browser",
      body: "You can now browse everything I know how to do.",
      link_path: "/skills",
      starts_ms: Date.now() - DAY,
      expires_ms: null,
      min_active_days: null,
      active: true,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a regular gets an offer carrying their own link", () => {
    const offer = pickOffer(session, deps);
    expect(offer).not.toBeNull();
    expect(offer?.url).toContain("/skills");
    expect(offer?.url).toContain(offer?.token ?? "never");
    expect(offer?.block).toContain("mention only if it genuinely fits");
  });

  test("the occasional texter is never offered anything", () => {
    expect(pickOffer(`imessage:dm:${OCCASIONAL}`, deps)).toBeNull();
  });

  test("a group is never offered anything", () => {
    expect(pickOffer("imessage:group:iMessage;+;chat-abc", deps)).toBeNull();
  });

  test("the block tells the model that saying nothing is correct", () => {
    // Without this, an injected block is read as a task and gets wedged into
    // an unrelated reply — the exact tonal break this must avoid.
    const block = renderBlock(
      { id: "x", title: "t", body: "b", link_path: "/skills" } as never,
      "https://example.test/u/a/b/skills",
    );
    expect(block).toContain("say nothing about it");
    expect(block).toContain("Never open with it");
  });

  test("a reply carrying the link marks it told, and it is never raised again", () => {
    const offer = pickOffer(session, deps);
    if (!offer) throw new Error("expected an offer");
    expect(confirmDelivery(session, offer, `sure — here you go: ${offer.url}`, deps)).toBe(true);
    expect(store.delivery("ann_1", session)?.state).toBe("delivered");
    // Even with the cooldown wound back, a told announcement stays told.
    expect(pickOffer(session, { ...deps, now: () => Date.now() + 400 * DAY })).toBeNull();
  });

  test("a reply that ignored it is not counted as told", () => {
    const offer = pickOffer(session, deps);
    if (!offer) throw new Error("expected an offer");
    expect(confirmDelivery(session, offer, "yeah the game's at 7", deps)).toBe(false);
    expect(store.delivery("ann_1", session)?.state).toBe("offered");
  });

  test("a declined offer is not re-raised the same day", () => {
    expect(pickOffer(session, deps)).not.toBeNull();
    expect(pickOffer(session, deps)).toBeNull();
  });

  test("after max_offers chances it is given up on, not retried forever", () => {
    // A natural opening that has not appeared in three separate conversations
    // is not going to. Continuing is nagging.
    let now = Date.now();
    const step = () => {
      now += 5 * DAY;
      return pickOffer(session, { ...deps, now: () => now });
    };
    expect(pickOffer(session, deps)).not.toBeNull();
    expect(step()).not.toBeNull();
    expect(step()).not.toBeNull();
    expect(step()).toBeNull();
    expect(store.delivery("ann_1", session)?.state).toBe("exhausted");
  });

  test("a retired announcement stops being offered", () => {
    store.setActive("ann_1", false);
    expect(pickOffer(session, deps)).toBeNull();
  });

  test("one that has not started yet, or has expired, is inert", () => {
    store.setActive("ann_1", false);
    store.add({
      id: "future",
      title: "later",
      body: "b",
      link_path: "",
      starts_ms: Date.now() + 10 * DAY,
      expires_ms: null,
      min_active_days: null,
      active: true,
    });
    store.add({
      id: "past",
      title: "over",
      body: "b",
      link_path: "",
      starts_ms: Date.now() - 20 * DAY,
      expires_ms: Date.now() - DAY,
      min_active_days: null,
      active: true,
    });
    expect(pickOffer(session, deps)).toBeNull();
  });

  test("only one thing is offered at a time, oldest first", () => {
    // Oldest first so a backlog drains; without it the oldest entry is
    // silently never told to anyone.
    store.add({
      id: "ann_2",
      title: "Newer",
      body: "b",
      link_path: "",
      starts_ms: Date.now() - DAY,
      expires_ms: null,
      min_active_days: null,
      active: true,
    });
    const first = pickOffer(session, deps);
    expect(first?.announcement.id).toBe("ann_1");
  });

  test("the global cooldown blocks a SECOND announcement, not just a repeat", () => {
    const offer = pickOffer(session, deps);
    if (!offer) throw new Error("expected an offer");
    confirmDelivery(session, offer, offer.url, deps);
    store.add({
      id: "ann_2",
      title: "Another",
      body: "b",
      link_path: "",
      starts_ms: Date.now() - DAY,
      expires_ms: null,
      min_active_days: null,
      active: true,
    });
    // Told about something two days ago; the next thing waits.
    expect(pickOffer(session, { ...deps, now: () => Date.now() + 2 * DAY })).toBeNull();
    expect(pickOffer(session, { ...deps, now: () => Date.now() + 20 * DAY })).not.toBeNull();
  });
});

describe("where a link may point", () => {
  test("a tab id, however it was typed, becomes a fragment", () => {
    // "/skills" is the obvious thing to type and the dangerous one: the
    // portal's tabs are hash anchors, so that path answers HTTP 200 with the
    // dashboard shell — the wrong page, not an error.
    for (const raw of ["skills", "#skills", "/skills", "  Skills  "]) {
      const r = normalizeLink(raw);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("unreachable");
      expect(r.linkPath).toBe("#skills");
    }
  });

  test("empty means the portal front page", () => {
    const r = normalizeLink("");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.linkPath).toBe("");
  });

  test("anything that is not a real tab is refused, not silently shipped", () => {
    for (const raw of ["setting", "/skill", "https://example.com", "../admin"]) {
      expect(normalizeLink(raw).ok).toBe(false);
    }
  });

  test("the tab list matches the portal's own, so a new tab cannot drift", () => {
    // Two separate lists — the daemon must not import the dashboard's view
    // layer — so they are pinned together here rather than by a comment
    // asking politely.
    const view = readFileSync(
      join(import.meta.dir, "..", "dashboard", "server", "views", "portalPage.ts"),
      "utf8",
    );
    const block = view.slice(
      view.indexOf("const TAB_DEFS"),
      view.indexOf("export function renderPortalPage"),
    );
    const ids = [...block.matchAll(/id:\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect([...PORTAL_TABS].sort()).toEqual([...ids].sort());
  });
});
