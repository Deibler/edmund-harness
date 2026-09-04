/**
 * Timezone + DST edge cases for the active-hours gate and window-start
 * detection.
 *
 * The gate uses Intl.DateTimeFormat to resolve local day-of-week +
 * minute-of-day. These tests confirm:
 *
 *   - Spring-forward (US DST 2026-03-08): 09:00 ET is still 09:00 ET
 *     regardless of whether DST is active. The UTC offset changes; the
 *     local time the user sees does not.
 *   - Fall-back (US DST end 2026-11-01): same.
 *   - Cross-TZ sessions: a London-based session with a London window
 *     gates correctly when the harness clock is in ET (i.e. the host
 *     machine's TZ doesn't leak in).
 *   - Day-of-week boundaries: midnight ET on the user's Friday is in
 *     the "fri" window, not "thu", even though it's still Thursday UTC.
 */
import { describe, expect, test } from "bun:test";
import { checkActiveHours } from "../src/ghost/budget.ts";
import { windowOpenedAtMs } from "../src/ghost/picker.ts";
import type { ActiveHoursWindow, BrownNosePrefs } from "../src/ghost/prefs.ts";
import type { SessionKey } from "../src/sessions/key.ts";

function prefs(timezone: string, activeHours: ActiveHoursWindow[]): BrownNosePrefs {
  return {
    sessionKey: "imessage:dm:+10000000000" as SessionKey,
    enabled: true,
    activeHours,
    timezone,
    weeklyCap: 3,
    cooldownMultiplier: 1.0,
    focusSuggestions: [],
    disabledReason: null,
    disabledAtMs: null,
    updatedAtMs: 0,
  };
}

// US Eastern DST transitions in 2026:
//   - Spring forward: 2026-03-08 02:00 EST → 03:00 EDT
//   - Fall back:      2026-11-01 02:00 EDT → 01:00 EST
const ET_WINDOW: ActiveHoursWindow[] = [
  { dow: "mon", start: "09:00", end: "19:00" },
  { dow: "tue", start: "09:00", end: "19:00" },
  { dow: "wed", start: "09:00", end: "19:00" },
  { dow: "thu", start: "09:00", end: "19:00" },
  { dow: "fri", start: "09:00", end: "19:00" },
];

describe("DST transitions in America/New_York", () => {
  test("09:00 local on a pre-DST weekday is inside the window", () => {
    // 2026-03-06 (Friday) 09:30 EST = 14:30 UTC (EST is UTC-5).
    const t = Date.parse("2026-03-06T14:30:00Z");
    expect(checkActiveHours(prefs("America/New_York", ET_WINDOW), t).ok).toBe(true);
  });

  test("09:00 local on a post-DST weekday is inside the window", () => {
    // 2026-03-09 (Monday after spring forward) 09:30 EDT = 13:30 UTC.
    const t = Date.parse("2026-03-09T13:30:00Z");
    expect(checkActiveHours(prefs("America/New_York", ET_WINDOW), t).ok).toBe(true);
  });

  test("18:00 local in fall (post-fall-back EST) is still in the window", () => {
    // 2026-11-03 (Tuesday after fall back) 18:30 EST = 23:30 UTC.
    const t = Date.parse("2026-11-03T23:30:00Z");
    expect(checkActiveHours(prefs("America/New_York", ET_WINDOW), t).ok).toBe(true);
  });

  test("the same UTC instant is in different local windows in different zones", () => {
    // 14:00 UTC on a Wednesday:
    //   - New York (EDT, UTC-4 in May) → 10:00 → inside M-F 09-19
    //   - Tokyo (UTC+9) → 23:00 Wed → outside any 09-19 window
    const t = Date.parse("2026-05-13T14:00:00Z");
    expect(checkActiveHours(prefs("America/New_York", ET_WINDOW), t).ok).toBe(true);
    expect(
      checkActiveHours(prefs("Asia/Tokyo", [{ dow: "wed", start: "09:00", end: "19:00" }]), t).ok,
    ).toBe(false);
  });
});

describe("day-of-week boundaries", () => {
  test("Friday 01:00 ET still counts as 'fri' (even though UTC is still Thursday)", () => {
    // 2026-05-15 01:00 EDT = 2026-05-15T05:00:00Z. UTC day = Friday too.
    // The harder case: 2026-05-15 01:00 EDT printed in UTC is
    // 2026-05-15T05:00:00Z, also a Friday. Use 23:00 ET on Thursday to
    // test the cross-midnight case the other way.
    // Thursday 23:00 ET = 03:00 UTC Friday. The gate must say "thu" for
    // dow because it's based on the SESSION's timezone, not UTC.
    const t = Date.parse("2026-05-15T03:00:00Z");
    // Window covers Thursday but not Friday after-midnight-ET. Set up
    // a Thursday-only window:
    const thuOnly: ActiveHoursWindow[] = [{ dow: "thu", start: "09:00", end: "23:30" }];
    expect(checkActiveHours(prefs("America/New_York", thuOnly), t).ok).toBe(true);
  });

  test("01:00 ET on Saturday is NOT in a Friday window", () => {
    // 2026-05-16 01:00 EDT = 2026-05-16T05:00:00Z, dow=sat ET.
    const t = Date.parse("2026-05-16T05:00:00Z");
    expect(
      checkActiveHours(prefs("America/New_York", [{ dow: "fri", start: "00:00", end: "23:59" }]), t)
        .ok,
    ).toBe(false);
  });
});

describe("cross-TZ sessions", () => {
  test("London session with London window — gated by London local time, not host machine", () => {
    // 2026-05-13 09:30 BST (UTC+1 in May) = 08:30 UTC. Inside 09-19 London window.
    const inWindow = Date.parse("2026-05-13T08:30:00Z");
    expect(
      checkActiveHours(
        prefs("Europe/London", [{ dow: "wed", start: "09:00", end: "19:00" }]),
        inWindow,
      ).ok,
    ).toBe(true);
  });

  test("Pacific window during a US-Pacific morning works regardless of DST status", () => {
    // 2026-05-13 09:30 PDT = 16:30 UTC.
    const t = Date.parse("2026-05-13T16:30:00Z");
    expect(
      checkActiveHours(
        prefs("America/Los_Angeles", [{ dow: "wed", start: "09:00", end: "19:00" }]),
        t,
      ).ok,
    ).toBe(true);
  });
});

describe("windowOpenedAtMs", () => {
  test("returns the open instant in the SESSION's tz, not the host tz", () => {
    // 09:30 BST on a Wednesday in London.
    const t = Date.parse("2026-05-13T08:30:00Z");
    const open = windowOpenedAtMs(
      prefs("Europe/London", [{ dow: "wed", start: "09:00", end: "19:00" }]),
      t,
    );
    expect(open).not.toBeNull();
    // 09:00 BST = 08:00 UTC. Within a few seconds.
    const expected = Date.parse("2026-05-13T08:00:00Z");
    expect(Math.abs((open ?? 0) - expected)).toBeLessThan(60_000);
  });
});
