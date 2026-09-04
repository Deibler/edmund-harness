/**
 * Round-trip tests for the brown-nose prefs store + auto-enroll
 * migration. Uses a real temp state.db (bun:sqlite is fast and the
 * surface is small).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ACTIVE_HOURS_DM,
  DEFAULT_ACTIVE_HOURS_GROUP,
  GhostPrefsStore,
  autoEnrollSessions,
} from "../src/ghost/prefs.ts";
import type { SessionKey } from "../src/sessions/key.ts";

function newStore(): { store: GhostPrefsStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "edmund-bn-prefs-"));
  const store = new GhostPrefsStore(dir);
  return {
    store,
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const JORDAN: SessionKey = "imessage:dm:+15550100001" as SessionKey;
const RILEY: SessionKey = "imessage:dm:+15550100002" as SessionKey;
const GROUP_A: SessionKey = "imessage:group:any-abc123" as SessionKey;

describe("GhostPrefsStore", () => {
  test("get on a fresh store returns null", () => {
    const { store, cleanup } = newStore();
    try {
      expect(store.get(JORDAN)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("upsert with defaultsIfNew inserts a new row", () => {
    const { store, cleanup } = newStore();
    try {
      const row = store.upsert(JORDAN, {
        defaultsIfNew: {
          enabled: true,
          activeHours: DEFAULT_ACTIVE_HOURS_DM,
          timezone: "America/New_York",
          weeklyCap: 3,
        },
      });
      expect(row.enabled).toBe(true);
      expect(row.activeHours.length).toBe(7); // every day (evenings + weekends included)
      expect(row.timezone).toBe("America/New_York");

      const reread = store.get(JORDAN);
      expect(reread).not.toBeNull();
      expect(reread!.weeklyCap).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("upsert without defaultsIfNew throws for new sessions", () => {
    const { store, cleanup } = newStore();
    try {
      expect(() => store.upsert(JORDAN, { enabled: false })).toThrow();
    } finally {
      cleanup();
    }
  });

  test("update merges partial fields without losing the rest", () => {
    const { store, cleanup } = newStore();
    try {
      store.upsert(JORDAN, {
        defaultsIfNew: {
          enabled: true,
          activeHours: DEFAULT_ACTIVE_HOURS_DM,
          timezone: "America/New_York",
          weeklyCap: 3,
        },
      });
      const updated = store.upsert(JORDAN, { enabled: false, disabledReason: "test" });
      expect(updated.enabled).toBe(false);
      expect(updated.disabledReason).toBe("test");
      // Untouched fields preserved.
      expect(updated.weeklyCap).toBe(3);
      expect(updated.timezone).toBe("America/New_York");
      expect(updated.activeHours.length).toBe(7);
    } finally {
      cleanup();
    }
  });

  test("list returns all rows sorted by session_key", () => {
    const { store, cleanup } = newStore();
    try {
      for (const k of [RILEY, JORDAN]) {
        store.upsert(k, {
          defaultsIfNew: {
            enabled: true,
            activeHours: DEFAULT_ACTIVE_HOURS_DM,
            timezone: "America/New_York",
            weeklyCap: 3,
          },
        });
      }
      const rows = store.list();
      expect(rows.length).toBe(2);
      // Lexicographic — JORDAN (+17177...) sorts before RILEY (+17178...)
      expect(rows[0]!.sessionKey).toBe(JORDAN);
    } finally {
      cleanup();
    }
  });

  test("remove drops the row", () => {
    const { store, cleanup } = newStore();
    try {
      store.upsert(JORDAN, {
        defaultsIfNew: {
          enabled: true,
          activeHours: DEFAULT_ACTIVE_HOURS_DM,
          timezone: "America/New_York",
          weeklyCap: 3,
        },
      });
      store.remove(JORDAN);
      expect(store.get(JORDAN)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("recordFire returns an id and recentFires reads back", () => {
    const { store, cleanup } = newStore();
    try {
      const id = store.recordFire({
        sessionKey: JORDAN,
        firedAtMs: 1_000_000,
        brief: "hike forecast",
        tags: ["weekend", "weather"],
      });
      expect(id).toBeGreaterThan(0);
      const recent = store.recentFires(JORDAN, 5);
      expect(recent.length).toBe(1);
      expect(recent[0]!.brief).toBe("hike forecast");
      expect(recent[0]!.tags).toEqual(["weekend", "weather"]);
      expect(recent[0]!.outcome).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("recordOutcome backfills outcome + outcomeAtMs", () => {
    const { store, cleanup } = newStore();
    try {
      const id = store.recordFire({
        sessionKey: JORDAN,
        firedAtMs: 1_000_000,
        brief: "x",
        tags: [],
      });
      store.recordOutcome(id, "pushed_back");
      const recent = store.recentFires(JORDAN, 1);
      expect(recent[0]!.outcome).toBe("pushed_back");
      expect(recent[0]!.outcomeAtMs).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("firesSince returns only fires after the cutoff", () => {
    const { store, cleanup } = newStore();
    try {
      store.recordFire({ sessionKey: JORDAN, firedAtMs: 1_000, brief: "old", tags: [] });
      store.recordFire({ sessionKey: JORDAN, firedAtMs: 5_000, brief: "new", tags: [] });
      const since = store.firesSince(JORDAN, 2_000);
      expect(since.length).toBe(1);
      expect(since[0]!.brief).toBe("new");
    } finally {
      cleanup();
    }
  });
});

describe("autoEnrollSessions", () => {
  test("enrolls DMs with DM defaults", () => {
    const { store, cleanup } = newStore();
    try {
      const added = autoEnrollSessions(store, [{ sessionKey: JORDAN, isGroup: false }], {
        dmEnabled: true,
        groupEnabled: false,
        timezone: "America/New_York",
        weeklyCap: 3,
      });
      expect(added).toBe(1);
      const row = store.get(JORDAN)!;
      expect(row.enabled).toBe(true);
      expect(row.activeHours).toEqual(DEFAULT_ACTIVE_HOURS_DM);
    } finally {
      cleanup();
    }
  });

  test("enrolls groups disabled with empty active hours", () => {
    const { store, cleanup } = newStore();
    try {
      autoEnrollSessions(store, [{ sessionKey: GROUP_A, isGroup: true }], {
        dmEnabled: true,
        groupEnabled: false,
        timezone: "America/New_York",
        weeklyCap: 3,
      });
      const row = store.get(GROUP_A)!;
      expect(row.enabled).toBe(false);
      expect(row.activeHours).toEqual(DEFAULT_ACTIVE_HOURS_GROUP);
    } finally {
      cleanup();
    }
  });

  test("idempotent — existing rows are not overwritten", () => {
    const { store, cleanup } = newStore();
    try {
      store.upsert(JORDAN, {
        defaultsIfNew: {
          enabled: false,
          activeHours: [],
          timezone: "Europe/London",
          weeklyCap: 1,
        },
      });
      const added = autoEnrollSessions(store, [{ sessionKey: JORDAN, isGroup: false }], {
        dmEnabled: true,
        groupEnabled: false,
        timezone: "America/New_York",
        weeklyCap: 3,
      });
      expect(added).toBe(0);
      const row = store.get(JORDAN)!;
      expect(row.timezone).toBe("Europe/London"); // unchanged
      expect(row.enabled).toBe(false);
    } finally {
      cleanup();
    }
  });
});
