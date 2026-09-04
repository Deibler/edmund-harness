/**
 * Tests for the brown-nose scheduling fixes: active-hours clamping at
 * enqueue time, mid-fire deferral of once-jobs, and the
 * nextActiveStartMs window helper.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config/config.ts";
import { CronStore } from "../src/cron/store.ts";
import { checkActiveHours, nextActiveStartMs } from "../src/ghost/budget.ts";
import { DEFAULT_ACTIVE_HOURS_DM } from "../src/ghost/prefs.ts";
import { enqueueBrownNoseFire } from "../src/proactive/queue.ts";
import type { SessionKey } from "../src/sessions/key.ts";

// A weekday at 08:00 ET (before the 09:00 DM window opens) and the same
// weekday at noon (inside the window). These are derived from "now" rather
// than hardcoded: the enqueue path drops any fire whose time has already
// passed, so an absolute date silently rots the moment the calendar passes
// it (which is exactly what happened to the original 2026-06-16 fixture).
// Deriving from Date.now() keeps them safely future forever.
//
// nyOffsetMs returns how far America/New_York is behind UTC at an instant
// (4h in EDT, 5h in EST) so the wall-clock arithmetic stays correct
// year-round without pulling in luxon/moment.
function nyOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(utcMs);
  const f = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const hour = f("hour") % 24; // Intl can emit "24" at midnight on some platforms
  const asIfUtc = Date.UTC(f("year"), f("month") - 1, f("day"), hour, f("minute"), f("second"));
  return utcMs - asIfUtc; // positive: NY behind UTC
}

// UTC instant of `hourEt:00` ET on the first weekday at least `minDaysAhead`
// days from now. DST transitions land at 02:00 on Sundays, so a weekday
// fixture at 08:00/12:00 is never on a transition boundary.
function nyWeekdayAt(hourEt: number, minDaysAhead: number): number {
  const DAY = 24 * 3_600_000;
  for (let d = minDaysAhead; d < minDaysAhead + 7; d++) {
    const probe = Date.now() + d * DAY;
    const [y, m, day] = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(probe)
      .split("-")
      .map(Number);
    let utc = Date.UTC(y!, m! - 1, day!, hourEt, 0, 0);
    utc += nyOffsetMs(utc); // shift the as-if-UTC fields into real ET wall-clock
    const wd = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    })
      .format(utc)
      .toLowerCase();
    if (["mon", "tue", "wed", "thu", "fri"].includes(wd)) return utc;
  }
  throw new Error("unreachable: a 7-day span always contains a weekday");
}

const TUE_8AM_ET = nyWeekdayAt(8, 9); // weekday 08:00 ET, ≥9 days out
const TUE_NOON_ET = TUE_8AM_ET + 4 * 3_600_000; // same weekday 12:00 ET (no DST hop 08→12)
const PREFS = { activeHours: DEFAULT_ACTIVE_HOURS_DM, timezone: "America/New_York" };

describe("nextActiveStartMs", () => {
  test("inside a window returns fromMs unchanged", () => {
    expect(nextActiveStartMs(PREFS, TUE_NOON_ET)).toBe(TUE_NOON_ET);
  });

  test("before the window open rolls forward to the open", () => {
    const next = nextActiveStartMs(PREFS, TUE_8AM_ET);
    expect(next).not.toBeNull();
    // Tue 09:00 EDT = 13:00Z — exactly one hour later.
    expect(next).toBe(TUE_8AM_ET + 60 * 60_000);
    expect(checkActiveHours({ ...PREFS } as never, next!).ok).toBe(true);
  });

  test("after close rolls to the NEXT day's open", () => {
    // Tue 22:00 EDT (after 21:00 close) → Wed 09:00 EDT.
    const tue10pm = Date.parse("2026-06-17T02:00:00Z");
    const next = nextActiveStartMs(PREFS, tue10pm);
    expect(next).toBe(Date.parse("2026-06-17T13:00:00Z"));
  });

  test("weekends are inside the default windows now", () => {
    // Sat 14:00 EDT — the slot that burned 61 ticks under the old default.
    const sat2pm = Date.parse("2026-06-20T18:00:00Z");
    expect(checkActiveHours(PREFS as never, sat2pm).ok).toBe(true);
  });

  test("no windows at all returns null", () => {
    expect(
      nextActiveStartMs({ activeHours: [], timezone: "America/New_York" }, TUE_8AM_ET),
    ).toBeNull();
  });
});

describe("enqueueBrownNoseFire active-hours clamp", () => {
  let dir: string;
  let crons: CronStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edmund-bn-sched-"));
    crons = new CronStore(dir);
  });
  afterEach(() => {
    crons.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = {
    brown_nose: { schedule_jitter_min_minutes: 0, schedule_jitter_max_minutes: 0 },
  } as unknown as Config;

  const decision = (fireAtMs: number) => ({
    act: true as const,
    tickAtMs: fireAtMs - 3_600_000,
    fireAtMs,
    brief: "morning hook",
    tags: ["test"],
    expiresAtMs: fireAtMs + 24 * 3_600_000,
    confidence: "medium" as const,
  });

  test("out-of-window fire time is moved into the window", () => {
    const res = enqueueBrownNoseFire({
      sessionKey: "dm:+1555" as SessionKey,
      decision: decision(TUE_8AM_ET),
      config,
      crons,
      sessionPrefs: PREFS,
      noJitter: true,
    });
    expect(res.enqueued).toBe(true);
    if (res.enqueued) {
      expect(checkActiveHours(PREFS as never, res.jitteredFireAtMs).ok).toBe(true);
      expect(res.jitteredFireAtMs).toBe(TUE_8AM_ET + 60 * 60_000);
    }
  });

  test("in-window fire time is untouched", () => {
    const res = enqueueBrownNoseFire({
      sessionKey: "dm:+1555" as SessionKey,
      decision: decision(TUE_NOON_ET),
      config,
      crons,
      sessionPrefs: PREFS,
      noJitter: true,
    });
    expect(res.enqueued).toBe(true);
    if (res.enqueued) expect(res.jitteredFireAtMs).toBe(TUE_NOON_ET);
  });

  test("without prefs the old behavior is preserved", () => {
    const res = enqueueBrownNoseFire({
      sessionKey: "dm:+1555" as SessionKey,
      decision: decision(TUE_8AM_ET),
      config,
      crons,
      noJitter: true,
    });
    expect(res.enqueued).toBe(true);
    if (res.enqueued) expect(res.jitteredFireAtMs).toBe(TUE_8AM_ET);
  });
});

describe("enqueueBrownNoseFire hard spacing rules", () => {
  let dir: string;
  let crons: CronStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edmund-bn-spacing-"));
    crons = new CronStore(dir);
  });
  afterEach(() => {
    crons.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = {
    brown_nose: { schedule_jitter_min_minutes: 0, schedule_jitter_max_minutes: 0 },
  } as unknown as Config;

  const decision = (fireAtMs: number, expiresAtMs = fireAtMs + 24 * 3_600_000) => ({
    act: true as const,
    tickAtMs: fireAtMs - 3_600_000,
    fireAtMs,
    brief: "hook",
    tags: ["test"],
    expiresAtMs,
    confidence: "medium" as const,
  });

  test("a second enqueue is rejected while one brown-nose is queued", () => {
    const key = "imessage:dm:+1555" as SessionKey;
    const first = enqueueBrownNoseFire({
      sessionKey: key,
      decision: decision(TUE_NOON_ET),
      config,
      crons,
      noJitter: true,
    });
    expect(first.enqueued).toBe(true);

    const second = enqueueBrownNoseFire({
      sessionKey: key,
      decision: decision(TUE_NOON_ET + 3_600_000),
      config,
      crons,
      noJitter: true,
    });
    expect(second.enqueued).toBe(false);
    if (!second.enqueued) expect(second.reason).toContain("already queued");

    // …but a DIFFERENT chat is unaffected.
    const other = enqueueBrownNoseFire({
      sessionKey: "imessage:dm:+1666" as SessionKey,
      decision: decision(TUE_NOON_ET),
      config,
      crons,
      noJitter: true,
    });
    expect(other.enqueued).toBe(true);
  });

  test("fire within 48h of the last real fire is pushed to the floor", () => {
    const key = "imessage:dm:+1555" as SessionKey;
    const lastFiredAtMs = TUE_NOON_ET - 12 * 3_600_000; // fired 12h before the proposal
    const prefsStore = {
      recentFires: () => [{ firedAtMs: lastFiredAtMs }],
    };
    const res = enqueueBrownNoseFire({
      sessionKey: key,
      decision: decision(TUE_NOON_ET, TUE_NOON_ET + 5 * 24 * 3_600_000),
      config,
      crons,
      prefsStore,
      noJitter: true,
    });
    expect(res.enqueued).toBe(true);
    if (res.enqueued) {
      expect(res.jitteredFireAtMs).toBeGreaterThanOrEqual(lastFiredAtMs + 48 * 3_600_000);
    }
  });

  test("rejected outright when the 48h floor is past the brief's expiry", () => {
    const key = "imessage:dm:+1555" as SessionKey;
    const prefsStore = {
      recentFires: () => [{ firedAtMs: TUE_NOON_ET - 3_600_000 }], // fired 1h ago
    };
    const res = enqueueBrownNoseFire({
      sessionKey: key,
      decision: decision(TUE_NOON_ET, TUE_NOON_ET + 6 * 3_600_000), // expires in 6h
      config,
      crons,
      prefsStore,
      noJitter: true,
    });
    expect(res.enqueued).toBe(false);
    if (!res.enqueued) expect(res.reason).toContain("48h spacing");
  });

  test("a fire already older than 48h does not interfere", () => {
    const prefsStore = {
      recentFires: () => [{ firedAtMs: TUE_NOON_ET - 72 * 3_600_000 }],
    };
    const res = enqueueBrownNoseFire({
      sessionKey: "imessage:dm:+1555" as SessionKey,
      decision: decision(TUE_NOON_ET),
      config,
      crons,
      prefsStore,
      noJitter: true,
    });
    expect(res.enqueued).toBe(true);
    if (res.enqueued) expect(res.jitteredFireAtMs).toBe(TUE_NOON_ET);
  });
});

describe("submit_decision fire-time validation", () => {
  const NOW = Date.parse("2026-06-10T18:00:00Z");
  const GUARD = { activeHours: DEFAULT_ACTIVE_HOURS_DM, timezone: "America/New_York" };

  test("past fire_at_ms returns a retryable error", async () => {
    const { validateFireTime } = await import("../src/ghost/mcp-server-validate.ts");
    expect(validateFireTime(NOW - 365 * 24 * 3_600_000, undefined, NOW, GUARD)).toContain(
      "IN THE PAST",
    );
  });

  test("far-future fire_at_ms returns a retryable error", async () => {
    const { validateFireTime } = await import("../src/ghost/mcp-server-validate.ts");
    expect(validateFireTime(NOW + 30 * 24 * 3_600_000, undefined, NOW, GUARD)).toContain("14 days");
  });

  test("out-of-window fire_at_ms names the next opening", async () => {
    const { validateFireTime } = await import("../src/ghost/mcp-server-validate.ts");
    // Wed 23:30 ET = Thu 03:30Z — outside the 09:00–21:00 window.
    const lateNight = Date.parse("2026-06-11T03:30:00Z");
    const err = validateFireTime(lateNight, undefined, NOW, GUARD);
    expect(err).toContain("OUTSIDE");
    expect(err).toContain(String(nextActiveStartMs(GUARD, lateNight)));
  });

  test("expiry before fire returns an error; valid times pass", async () => {
    const { validateFireTime } = await import("../src/ghost/mcp-server-validate.ts");
    const noon = Date.parse("2026-06-11T16:00:00Z"); // Thu noon ET, in window
    expect(validateFireTime(noon, noon - 1, NOW, GUARD)).toContain("dead on arrival");
    expect(validateFireTime(noon, noon + 3_600_000, NOW, GUARD)).toBeNull();
    expect(validateFireTime(undefined, undefined, NOW, GUARD)).toBeNull(); // "now"
    // empty windows (groups) skip the window check
    expect(
      validateFireTime(NOW + 3_600_000, undefined, NOW, {
        activeHours: [],
        timezone: "America/New_York",
      }),
    ).toBeNull();
  });
});

describe("CronStore.deferMidFire", () => {
  let dir: string;
  let crons: CronStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edmund-defer-"));
    crons = new CronStore(dir);
  });
  afterEach(() => {
    crons.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("revives a once-job the scheduler already marked done", () => {
    const job = crons.create({
      sessionKey: "dm:+1555",
      systemEvent: "[BROWN_NOSE]{}",
      schedule: { kind: "once", atMs: Date.now() },
    });
    // Scheduler marks once-jobs done BEFORE invoking the handler.
    crons.markFired(job, Date.now());
    expect(crons.listActive().length).toBe(0);

    // bumpNextFire (active-only) silently no-ops — the original bug.
    crons.bumpNextFire(job.id, Date.now() + 60_000);
    expect(crons.listActive().length).toBe(0);

    const later = Date.now() + 60_000;
    expect(crons.deferMidFire(job.id, later)).toBe(true);
    const active = crons.listActive();
    expect(active.length).toBe(1);
    expect(active[0]!.nextFireMs).toBe(later);
  });

  test("never revives a canceled job", () => {
    const job = crons.create({
      sessionKey: "dm:+1555",
      systemEvent: "x",
      schedule: { kind: "once", atMs: Date.now() + 3_600_000 },
    });
    crons.cancel(job.id);
    expect(crons.deferMidFire(job.id, Date.now() + 60_000)).toBe(false);
    expect(crons.listActive().length).toBe(0);
  });
});
