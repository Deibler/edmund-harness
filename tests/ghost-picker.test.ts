/**
 * Pure unit tests for the ghost observer's priority picker.
 *
 * Priorities (highest first):
 *   1. window_start
 *   2. quiet_24h
 *   3. quiet_4h
 *   4. sweep (oldest tick wins)
 *
 * Each higher reason short-circuits lower ones for the same session.
 */
import { describe, expect, test } from "bun:test";
import { type TickReason, pickNextSession, windowOpenedAtMs } from "../src/ghost/picker.ts";
import type { BrownNosePrefs } from "../src/ghost/prefs.ts";
import type { SessionKey } from "../src/sessions/key.ts";

function prefs(key: string, overrides: Partial<BrownNosePrefs> = {}): BrownNosePrefs {
  return {
    sessionKey: key as SessionKey,
    enabled: true,
    activeHours: [{ dow: "mon", start: "09:00", end: "19:00" }],
    timezone: "America/New_York",
    weeklyCap: 3,
    cooldownMultiplier: 1.0,
    focusSuggestions: [],
    disabledReason: null,
    disabledAtMs: null,
    updatedAtMs: 0,
    ...overrides,
  };
}

// 2026-05-11 Monday 14:00 ET = 18:00 UTC — well inside the M-F 9-19 window.
const MON_14_ET = Date.parse("2026-05-11T18:00:00Z");
// Monday 09:05 ET — window just opened.
const MON_905_ET = Date.parse("2026-05-11T13:05:00Z");
// Monday 11:00 ET — inside the window but past the grace.
const MON_11_ET = Date.parse("2026-05-11T15:00:00Z");

describe("windowOpenedAtMs", () => {
  test("returns the open instant when inside the window", () => {
    const opened = windowOpenedAtMs(prefs("k"), MON_905_ET);
    expect(opened).not.toBeNull();
    // 09:00 ET on the same Monday — five minutes earlier than MON_905_ET.
    const expected = Date.parse("2026-05-11T13:00:00Z");
    // Allow a few seconds of slop since Intl rounds.
    expect(Math.abs((opened ?? 0) - expected)).toBeLessThan(60_000);
  });

  test("returns null outside the window", () => {
    // Sunday 14:00 ET — no Sunday window configured.
    const sun = Date.parse("2026-05-10T18:00:00Z");
    expect(windowOpenedAtMs(prefs("k"), sun)).toBeNull();
  });

  test("returns null when activeHours is empty", () => {
    expect(windowOpenedAtMs(prefs("k", { activeHours: [] }), MON_14_ET)).toBeNull();
  });
});

describe("pickNextSession — priority order", () => {
  test("window_start wins over sweep when fresh", () => {
    const a = prefs("a");
    const b = prefs("b");
    const result = pickNextSession({
      candidates: [a, b],
      activity: new Map([
        ["a", { lastInboundMs: 0, lastOutboundMs: 0 }],
        ["b", { lastInboundMs: 0, lastOutboundMs: 0 }],
      ]),
      lastTickAtMs: new Map([
        ["a", 0],
        ["b", MON_905_ET - 1_000_000],
      ]),
      lastTickByReason: new Map(),
      nowMs: MON_905_ET, // 5 min after window open
    });
    expect(result).not.toBeNull();
    // a OR b could be the window_start pick — both are inside the
    // window's grace. The point is the reason is window_start.
    expect(result!.reason).toBe("window_start");
  });

  test("window_start NOT triggered if we already ticked since the window opened", () => {
    const a = prefs("a");
    const windowOpened = Date.parse("2026-05-11T13:00:00Z"); // 09:00 ET
    const result = pickNextSession({
      candidates: [a],
      activity: new Map([["a", { lastInboundMs: 0, lastOutboundMs: 0 }]]),
      lastTickAtMs: new Map(),
      lastTickByReason: new Map([
        ["a", new Map<TickReason, number>([["window_start", windowOpened + 60_000]])],
      ]),
      nowMs: MON_905_ET,
    });
    // Falls through to sweep.
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("sweep");
  });

  test("quiet_24h wins over sweep when last inbound is ~24h ago", () => {
    const a = prefs("a");
    const lastInbound = MON_11_ET - 23 * 3_600_000; // 23h ago relative to now
    const result = pickNextSession({
      candidates: [a],
      activity: new Map([["a", { lastInboundMs: lastInbound, lastOutboundMs: 0 }]]),
      lastTickAtMs: new Map(),
      lastTickByReason: new Map(),
      nowMs: MON_11_ET, // past window-start grace
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("quiet_24h");
  });

  test("quiet_4h wins when last inbound is ~5h ago", () => {
    const a = prefs("a");
    const lastInbound = MON_11_ET - 5 * 3_600_000;
    const result = pickNextSession({
      candidates: [a],
      activity: new Map([["a", { lastInboundMs: lastInbound, lastOutboundMs: 0 }]]),
      lastTickAtMs: new Map(),
      lastTickByReason: new Map(),
      nowMs: MON_11_ET,
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("quiet_4h");
  });

  test("falls through to sweep when no trigger fires; oldest wins", () => {
    const a = prefs("a");
    const b = prefs("b");
    const c = prefs("c");
    const result = pickNextSession({
      candidates: [a, b, c],
      activity: new Map([
        ["a", { lastInboundMs: MON_11_ET - 60_000, lastOutboundMs: 0 }],
        ["b", { lastInboundMs: MON_11_ET - 120_000, lastOutboundMs: 0 }],
        ["c", { lastInboundMs: MON_11_ET - 30_000, lastOutboundMs: 0 }],
      ]),
      lastTickAtMs: new Map([
        ["a", MON_11_ET - 1_000_000],
        ["b", MON_11_ET - 5_000_000],
        ["c", MON_11_ET - 100_000],
      ]),
      lastTickByReason: new Map(),
      nowMs: MON_11_ET,
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("sweep");
    expect(result!.sessionKey).toBe("b"); // oldest tick
  });

  test("returns null when there are no candidates", () => {
    const result = pickNextSession({
      candidates: [],
      activity: new Map(),
      lastTickAtMs: new Map(),
      lastTickByReason: new Map(),
      nowMs: MON_14_ET,
    });
    expect(result).toBeNull();
  });

  test("quiet_24h debounces — a just-ticked session is left alone entirely", () => {
    const a = prefs("a");
    const lastInbound = MON_11_ET - 23 * 3_600_000; // 23h ago relative to now
    const result = pickNextSession({
      candidates: [a],
      activity: new Map([["a", { lastInboundMs: lastInbound, lastOutboundMs: 0 }]]),
      lastTickAtMs: new Map([["a", MON_11_ET - 60_000]]),
      lastTickByReason: new Map([
        ["a", new Map<TickReason, number>([["quiet_24h", MON_11_ET - 60_000]])],
      ]),
      nowMs: MON_11_ET,
    });
    // quiet_24h is debounced AND the 45-min spacing floor holds (last tick
    // was 60s ago) — no tick at all. Re-deriving a NO a minute after the
    // last one was the old wasteful behavior.
    expect(result).toBeNull();
  });

  test("sweep change-gate — quiet chat with nothing new isn't re-swept inside 24h", () => {
    const a = prefs("a");
    const lastTick = MON_11_ET - 6 * 3_600_000; // ticked 6h ago
    const lastInbound = lastTick - 3_600_000; // inbound PREDATES the tick
    const result = pickNextSession({
      candidates: [a],
      activity: new Map([["a", { lastInboundMs: lastInbound, lastOutboundMs: 0 }]]),
      lastTickAtMs: new Map([["a", lastTick]]),
      lastTickByReason: new Map(),
      nowMs: MON_11_ET,
    });
    expect(result).toBeNull();
  });

  test("sweep change-gate — new inbound since the last tick makes it sweepable again", () => {
    const a = prefs("a");
    const lastTick = MON_11_ET - 6 * 3_600_000;
    const lastInbound = MON_11_ET - 3_600_000; // they texted AFTER the tick
    const result = pickNextSession({
      candidates: [a],
      activity: new Map([["a", { lastInboundMs: lastInbound, lastOutboundMs: 0 }]]),
      lastTickAtMs: new Map([["a", lastTick]]),
      lastTickByReason: new Map(),
      nowMs: MON_11_ET,
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("sweep");
  });

  test("sweep change-gate — even a dead chat gets a daily re-look", () => {
    const a = prefs("a");
    const lastTick = MON_11_ET - 25 * 3_600_000; // ticked 25h ago, nothing since
    const result = pickNextSession({
      candidates: [a],
      // inbound 30h ago — outside the quiet_24h band so sweep is the path
      activity: new Map([["a", { lastInboundMs: MON_11_ET - 30 * 3_600_000, lastOutboundMs: 0 }]]),
      lastTickAtMs: new Map([["a", lastTick]]),
      lastTickByReason: new Map(),
      nowMs: MON_11_ET,
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("sweep");
  });

  test("snooze — an actively snoozed session is skipped, new inbound voids it", () => {
    const base = prefs("a");
    const snoozed = {
      ...base,
      snoozeUntilMs: MON_11_ET + 24 * 3_600_000,
      snoozeSetAtMs: MON_11_ET - 3_600_000,
    };
    const noNewInbound = pickNextSession({
      candidates: [snoozed],
      activity: new Map([["a", { lastInboundMs: MON_11_ET - 2 * 3_600_000, lastOutboundMs: 0 }]]),
      lastTickAtMs: new Map(),
      lastTickByReason: new Map(),
      nowMs: MON_11_ET,
    });
    expect(noNewInbound).toBeNull();

    const newInbound = pickNextSession({
      candidates: [snoozed],
      activity: new Map([["a", { lastInboundMs: MON_11_ET - 60_000, lastOutboundMs: 0 }]]),
      lastTickAtMs: new Map(),
      lastTickByReason: new Map(),
      nowMs: MON_11_ET,
    });
    expect(newInbound).not.toBeNull();
  });
});

import { checkOutstandingFire, cooldownJitterFactor } from "../src/ghost/budget.ts";
import type { FireRecord } from "../src/ghost/prefs.ts";

describe("pacing gates", () => {
  const fire = (id: number, agoMs: number, outcome: FireRecord["outcome"]): FireRecord => ({
    id,
    sessionKey: "imessage:dm:+1" as never,
    firedAtMs: Date.now() - agoMs,
    brief: "b",
    tags: [],
    outcome,
    outcomeAtMs: null,
  });

  test("outstanding unanswered fire blocks the next one", () => {
    const r = checkOutstandingFire([fire(1, 3_600_000, null)], 0);
    expect(r.ok).toBe(false);
  });

  test("a reply after the fire clears the gate", () => {
    const f = fire(1, 3_600_000, null);
    const r = checkOutstandingFire([f], f.firedAtMs + 60_000);
    expect(r.ok).toBe(true);
  });

  test("a resolved outcome clears the gate", () => {
    expect(checkOutstandingFire([fire(1, 3_600_000, "ignored")], 0).ok).toBe(true);
    expect(checkOutstandingFire([], 0).ok).toBe(true);
  });

  test("cooldown jitter is deterministic per seed and spans [1,3)", () => {
    const seen = new Set<number>();
    for (const seed of [1, 2, 3, 42, 999, 123456]) {
      const a = cooldownJitterFactor(seed);
      expect(a).toBe(cooldownJitterFactor(seed));
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThan(3);
      seen.add(Math.round(a * 100));
    }
    expect(seen.size).toBeGreaterThan(3); // genuinely varied
  });
});
