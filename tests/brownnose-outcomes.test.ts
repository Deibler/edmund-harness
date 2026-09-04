/**
 * Tests for engagement-outcome learning: deterministic outcome
 * classification, the decay multiplier's positive-reinforcement branch,
 * and the ghost prompt's user-rhythm profile.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOutstandingFire, decayMultiplier } from "../src/ghost/budget.ts";
import { ENGAGED_WINDOW_MS, IGNORE_AFTER_MS, classifyOutcome } from "../src/ghost/outcomes.ts";
import { type FireRecord, GhostPrefsStore } from "../src/ghost/prefs.ts";
import { describeRhythm } from "../src/ghost/think.ts";
import type { HistoryLine } from "../src/imessage/history.ts";

const NOW = 1_750_000_000_000;

describe("classifyOutcome", () => {
  test("reply within the window → engaged", () => {
    expect(
      classifyOutcome({
        firedAtMs: NOW,
        firstInboundMs: NOW + 2 * 3_600_000,
        nowMs: NOW + 3 * 3_600_000,
      }),
    ).toEqual({ outcome: "engaged" });
  });

  test("first reply only after the window → ignored", () => {
    expect(
      classifyOutcome({
        firedAtMs: NOW,
        firstInboundMs: NOW + ENGAGED_WINDOW_MS + 60_000,
        nowMs: NOW + ENGAGED_WINDOW_MS + 120_000,
      }),
    ).toEqual({ outcome: "ignored" });
  });

  test("no reply yet, verdict still open → null", () => {
    expect(
      classifyOutcome({ firedAtMs: NOW, firstInboundMs: null, nowMs: NOW + 3_600_000 }),
    ).toBeNull();
  });

  test("no reply past the ignore deadline → ignored", () => {
    expect(
      classifyOutcome({
        firedAtMs: NOW,
        firstInboundMs: null,
        nowMs: NOW + IGNORE_AFTER_MS + 1,
      }),
    ).toEqual({ outcome: "ignored" });
  });
});

describe("decayMultiplier positive reinforcement", () => {
  const fire = (outcome: FireRecord["outcome"]): FireRecord => ({
    id: 1,
    sessionKey: "dm:+1555" as FireRecord["sessionKey"],
    firedAtMs: NOW,
    brief: "x",
    tags: [],
    outcome,
    outcomeAtMs: outcome ? NOW : null,
    reactionGlyph: null,
    delivered: outcome !== "vetoed" && outcome !== "error",
  });

  test("3+ engaged, zero negative → 0.75 (earned shorter cooldown)", () => {
    expect(decayMultiplier([fire("engaged"), fire("engaged"), fire("engaged")])).toBe(0.75);
  });

  test("clean but thin record stays at 1.0", () => {
    expect(decayMultiplier([fire("engaged"), fire("engaged")])).toBe(1.0);
    expect(decayMultiplier([fire(null), fire(null)])).toBe(1.0);
    expect(decayMultiplier([])).toBe(1.0);
  });

  test("any negative still decays, engagement notwithstanding", () => {
    expect(
      decayMultiplier([fire("engaged"), fire("engaged"), fire("engaged"), fire("ignored")]),
    ).toBe(1.5);
    expect(decayMultiplier([fire("pushed_back"), fire("ignored")])).toBe(2.0);
  });

  test("vetoed/error fires don't occupy window slots or count as negative", () => {
    // A run of vetoes must not dilute the last real outcomes out of the
    // 5-slot window: three vetoes + three engaged still earns 0.75.
    expect(
      decayMultiplier([
        fire("vetoed"),
        fire("vetoed"),
        fire("vetoed"),
        fire("engaged"),
        fire("engaged"),
        fire("engaged"),
      ]),
    ).toBe(0.75);
    // And infrastructure failures are neutral, not "ignored".
    expect(decayMultiplier([fire("error"), fire("error")])).toBe(1.0);
  });
});

describe("checkOutstandingFire with vetoed fires", () => {
  const fire = (outcome: FireRecord["outcome"]): FireRecord => ({
    id: 1,
    sessionKey: "dm:+1555" as FireRecord["sessionKey"],
    firedAtMs: NOW,
    brief: "x",
    tags: [],
    outcome,
    outcomeAtMs: outcome ? NOW : null,
    reactionGlyph: null,
    delivered: outcome !== "vetoed" && outcome !== "error",
  });

  test("a stamped veto releases the one-open-thread gate immediately", () => {
    // Pre-fix, a vetoed fire sat outcome=NULL and blocked all proactive
    // contact for up to 36h even though no message was ever sent.
    expect(checkOutstandingFire([fire("vetoed")], 0).ok).toBe(true);
  });

  test("a delivered fire awaiting its verdict still blocks", () => {
    expect(checkOutstandingFire([fire(null)], 0).ok).toBe(false);
  });
});

describe("GhostPrefsStore delivery-gated outcome sweep", () => {
  function tempStore() {
    const dir = mkdtempSync(join(tmpdir(), "bn-fires-"));
    const store = new GhostPrefsStore(dir);
    return {
      store,
      cleanup: () => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }
  const key = "imessage:dm:+15551234" as FireRecord["sessionKey"];

  test("undelivered fires are invisible to pendingOutcomes until markDelivered", () => {
    const { store, cleanup } = tempStore();
    try {
      const id = store.recordFire({ sessionKey: key, firedAtMs: NOW, brief: "b", tags: [] });
      expect(store.pendingOutcomes(10).map((f) => f.id)).not.toContain(id);
      store.markDelivered(id);
      expect(store.pendingOutcomes(10).map((f) => f.id)).toContain(id);
    } finally {
      cleanup();
    }
  });

  test("a vetoed fire never reaches the sweep", () => {
    const { store, cleanup } = tempStore();
    try {
      const id = store.recordFire({ sessionKey: key, firedAtMs: NOW, brief: "b", tags: [] });
      store.recordOutcome(id, "vetoed");
      expect(store.pendingOutcomes(10).map((f) => f.id)).not.toContain(id);
      const rec = store.recentFires(key, 1)[0];
      expect(rec?.outcome).toBe("vetoed");
      expect(rec?.delivered).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("describeRhythm", () => {
  const msg = (tsMs: number, fromMe = false): HistoryLine =>
    ({
      fromMe,
      fromHandle: fromMe ? null : "+1555",
      text: "hi",
      timestampMs: tsMs,
      attachments: [],
    }) as unknown as HistoryLine;

  // Build 30 user messages all at ~20:00 ET on consecutive days.
  const eightPmEt = Date.parse("2026-06-01T00:00:00Z"); // 20:00 EDT May 31
  const history = Array.from({ length: 30 }, (_, i) => msg(eightPmEt + i * 86_400_000));

  test("surfaces habitual hours and flags an off-hours now", () => {
    // "now" at 4am ET — far outside the user's single 20:00 habit.
    const nowOff = Date.parse("2026-06-09T08:00:00Z");
    const lines = describeRhythm(history, "America/New_York", nowOff);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("20:00");
    expect(lines.join("\n")).toContain("NOT one of their usual texting hours");
  });

  test("flags an in-rhythm now as typical", () => {
    const nowOn = Date.parse("2026-06-10T00:30:00Z"); // 20:30 EDT June 9
    const lines = describeRhythm(history, "America/New_York", nowOn);
    expect(lines.join("\n")).toContain("a typical texting hour");
  });

  test("too little signal → no section", () => {
    expect(describeRhythm(history.slice(0, 5), "America/New_York", NOW)).toEqual([]);
    expect(
      describeRhythm(
        history.map((h) => ({ ...h, fromMe: true })),
        "America/New_York",
        NOW,
      ),
    ).toEqual([]);
  });
});
