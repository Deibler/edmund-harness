/**
 * Pure unit tests for the brown-nose budget gates. No DB, no IO — the
 * gates take data in, return decisions out.
 */
import { describe, expect, test } from "bun:test";
import {
  checkActiveHours,
  checkCooldown,
  checkEnabled,
  checkWeeklyCap,
  cooldownJitterFactor,
  decayMultiplier,
  focusSuggestionStatus,
  preflightGate,
} from "../src/ghost/budget.ts";
import type {
  ActiveHoursWindow,
  BrownNosePrefs,
  FireRecord,
  FocusSuggestion,
} from "../src/ghost/prefs.ts";
import type { SessionKey } from "../src/sessions/key.ts";

function prefs(
  overrides: Partial<BrownNosePrefs> = {},
  activeHours: ActiveHoursWindow[] = [{ dow: "mon", start: "09:00", end: "19:00" }],
): BrownNosePrefs {
  return {
    sessionKey: "imessage:dm:+10000000000" as SessionKey,
    enabled: true,
    activeHours,
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

function fire(firedAtMs: number, outcome: FireRecord["outcome"] = null): FireRecord {
  return {
    id: 1,
    sessionKey: "imessage:dm:+10000000000" as SessionKey,
    firedAtMs,
    brief: "test",
    tags: [],
    outcome,
    outcomeAtMs: outcome ? firedAtMs + 60_000 : null,
  };
}

// Pick a known-Monday timestamp inside the 9-19 window in Eastern time
// for deterministic active-hours testing. 2026-05-11 (Monday) 14:00 ET
// is solidly in the window regardless of DST.
const MONDAY_14_ET = Date.parse("2026-05-11T18:00:00Z"); // 14:00 EDT

describe("checkEnabled", () => {
  test("ok when global on and session on", () => {
    expect(checkEnabled(prefs(), true).ok).toBe(true);
  });

  test("fails when global off", () => {
    const r = checkEnabled(prefs(), false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("global");
  });

  test("fails when session off; surfaces reason when present", () => {
    const r = checkEnabled(prefs({ enabled: false, disabledReason: "user said stop" }), true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("user said stop");
  });
});

describe("checkActiveHours", () => {
  test("ok inside the Monday 9-19 window", () => {
    expect(checkActiveHours(prefs(), MONDAY_14_ET).ok).toBe(true);
  });

  test("fails on Saturday with M-F windows only", () => {
    // 2026-05-16 Sat 14:00 ET
    const sat = Date.parse("2026-05-16T18:00:00Z");
    const r = checkActiveHours(prefs(), sat);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("outside active hours");
  });

  test("fails before window start same day", () => {
    // 2026-05-11 Mon 06:00 ET
    const before = Date.parse("2026-05-11T10:00:00Z");
    expect(checkActiveHours(prefs(), before).ok).toBe(false);
  });

  test("fails after window end same day", () => {
    // 2026-05-11 Mon 22:00 ET
    const after = Date.parse("2026-05-12T02:00:00Z");
    expect(checkActiveHours(prefs(), after).ok).toBe(false);
  });

  test("empty active hours fails closed", () => {
    expect(checkActiveHours(prefs({}, []), MONDAY_14_ET).ok).toBe(false);
  });
});

describe("checkCooldown", () => {
  test("ok with no fires", () => {
    expect(checkCooldown(prefs(), [], 5, Date.now()).ok).toBe(true);
  });

  test("blocks during cooldown at intensity 5 (24h)", () => {
    const now = Date.now();
    const r = checkCooldown(prefs(), [fire(now - 2 * 3_600_000)], 5, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("cooldown");
  });

  test("clears past cooldown at intensity 5 — beyond the 3× jitter ceiling", () => {
    const now = Date.now();
    // Jitter scales the 24h base by [1,3), so 73h is past any possible cooldown.
    const r = checkCooldown(prefs(), [fire(now - 73 * 3_600_000)], 5, now);
    expect(r.ok).toBe(true);
  });

  test("cooldown is jittered — the exact threshold depends on the fire id", () => {
    const now = Date.now();
    const f = fire(now - 30 * 3_600_000);
    const expected = 24 * 3_600_000 * cooldownJitterFactor(f.id);
    const r = checkCooldown(prefs(), [f], 5, now);
    expect(r.ok).toBe(now - f.firedAtMs >= expected);
  });

  test("multiplier doubles cooldown — 30h with 2× still blocks at intensity 5", () => {
    const now = Date.now();
    const r = checkCooldown(
      prefs({ cooldownMultiplier: 2.0 }),
      [fire(now - 30 * 3_600_000)],
      5,
      now,
    );
    expect(r.ok).toBe(false);
  });

  test("intensity 10 has 4h base cooldown — 13h ago clears any jitter", () => {
    const now = Date.now();
    const r = checkCooldown(prefs(), [fire(now - 13 * 3_600_000)], 10, now);
    expect(r.ok).toBe(true);
  });

  test("intensity 1 has 168h (7d) cooldown — 6d ago still blocked", () => {
    const now = Date.now();
    const r = checkCooldown(prefs(), [fire(now - 6 * 24 * 3_600_000)], 1, now);
    expect(r.ok).toBe(false);
  });
});

describe("checkWeeklyCap", () => {
  test("ok below cap", () => {
    const now = Date.now();
    expect(checkWeeklyCap(prefs(), [fire(now), fire(now - 1)]).ok).toBe(true);
  });

  test("blocks at cap", () => {
    const now = Date.now();
    const r = checkWeeklyCap(prefs(), [fire(now), fire(now - 1), fire(now - 2)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("3/3");
  });
});

describe("decayMultiplier", () => {
  test("0 negative → 1.0", () => {
    expect(decayMultiplier([])).toBe(1.0);
    expect(decayMultiplier([fire(0, "engaged")])).toBe(1.0);
  });

  test("1 negative → 1.5", () => {
    expect(decayMultiplier([fire(0, "ignored")])).toBe(1.5);
  });

  test("2 negative → 2.0", () => {
    expect(decayMultiplier([fire(0, "ignored"), fire(0, "pushed_back")])).toBe(2.0);
  });

  test("3 negative → 3.0", () => {
    expect(decayMultiplier([fire(0, "ignored"), fire(0, "ignored"), fire(0, "pushed_back")])).toBe(
      3.0,
    );
  });

  test("4+ negative caps at 4.0", () => {
    const all4 = [fire(0, "ignored"), fire(0, "ignored"), fire(0, "ignored"), fire(0, "ignored")];
    expect(decayMultiplier(all4)).toBe(4.0);
    const all5 = [...all4, fire(0, "pushed_back")];
    expect(decayMultiplier(all5)).toBe(4.0);
  });

  test("only considers last 5 fires", () => {
    // 2 ignored older + 1 engaged in last 5 → multiplier is for the
    // last 5 only. Build: [engaged, engaged, engaged, engaged, engaged,
    // ignored, ignored]. First 5 (newest) are all engaged → the older
    // ignores are invisible AND the clean engaged streak earns the
    // positive-reinforcement 0.75.
    const fires: FireRecord[] = [
      fire(100, "engaged"),
      fire(90, "engaged"),
      fire(80, "engaged"),
      fire(70, "engaged"),
      fire(60, "engaged"),
      fire(50, "ignored"),
      fire(40, "ignored"),
    ];
    expect(decayMultiplier(fires)).toBe(0.75);
  });
});

describe("focusSuggestionStatus", () => {
  const NOW = Date.now();
  function s(
    topic: string,
    usage: number,
    expires: number | null = null,
    weekStartMs: number | undefined = NOW - 3_600_000,
  ): FocusSuggestion {
    return { topic, usageCount: usage, weekStartMs, expiresAtMs: expires, createdAtMs: 0 };
  }

  test("under 3 uses → active", () => {
    const { active, overUsed } = focusSuggestionStatus([s("hiking", 2)], NOW);
    expect(active.length).toBe(1);
    expect(overUsed.length).toBe(0);
  });

  test("at 3 uses within a live week window → overUsed", () => {
    const { active, overUsed } = focusSuggestionStatus([s("hiking", 3)], NOW);
    expect(active.length).toBe(0);
    expect(overUsed.length).toBe(1);
  });

  test("a rolled week window un-sticks an over-used topic", () => {
    const { active, overUsed } = focusSuggestionStatus(
      [s("hiking", 3, null, NOW - 8 * 86_400_000)],
      NOW,
    );
    expect(overUsed.length).toBe(0);
    expect(active.length).toBe(1);
    expect(active[0]!.usageCount).toBe(0);
  });

  test("legacy rows without a week window read as fresh", () => {
    // Pre-fix rows can't say WHEN their uses happened; treat as stale.
    // (Built literally: passing `undefined` to the helper would take the
    // default parameter instead.)
    const legacy: FocusSuggestion = {
      topic: "hiking",
      usageCount: 3,
      expiresAtMs: null,
      createdAtMs: 0,
    };
    const { active, overUsed } = focusSuggestionStatus([legacy], NOW);
    expect(overUsed.length).toBe(0);
    expect(active.length).toBe(1);
  });

  test("expired suggestions drop entirely", () => {
    const { active, overUsed } = focusSuggestionStatus([s("old", 1, NOW - 1000)], NOW);
    expect(active.length).toBe(0);
    expect(overUsed.length).toBe(0);
  });
});

describe("preflightGate (composite)", () => {
  test("returns ok when every gate passes", () => {
    expect(
      preflightGate({
        prefs: prefs(),
        globalEnabled: true,
        intensity: 5,
        recentFires: [],
        weekFires: [],
        nowMs: MONDAY_14_ET,
      }).ok,
    ).toBe(true);
  });

  test("short-circuits on first failure (enabled before active hours)", () => {
    const r = preflightGate({
      prefs: prefs({ enabled: false, disabledReason: "test" }),
      globalEnabled: true,
      intensity: 5,
      recentFires: [],
      weekFires: [],
      nowMs: MONDAY_14_ET,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("test");
  });
});
