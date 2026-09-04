import { describe, expect, test } from "bun:test";
import { nextFire } from "../src/cron/next-fire.ts";

const MIN = 60_000;

describe("nextFire — one-shot", () => {
  test("returns atMs when in the future, clamps to `after` when past, 0 only for invalid input", () => {
    const now = Date.now();
    expect(nextFire({ kind: "once", atMs: now + 5 * MIN }, now)).toBe(now + 5 * MIN);
    // Past atMs now clamps to `after` (fire immediately) — lets the relay
    // schedule at Date.now() exactly and lets a missed one-shot still fire
    // after a daemon restart.
    expect(nextFire({ kind: "once", atMs: now - 1 }, now)).toBe(now);
    expect(nextFire({ kind: "once", atMs: now }, now)).toBe(now);
    // 0/negative atMs is still treated as invalid.
    expect(nextFire({ kind: "once", atMs: 0 }, now)).toBe(0);
  });
});

describe("nextFire — cron", () => {
  test("'* * * * *' fires at the next whole minute", () => {
    const after = new Date(2026, 4, 12, 14, 30, 17, 500).getTime(); // local
    const got = nextFire({ kind: "cron", expr: "* * * * *" }, after);
    const expected = new Date(2026, 4, 12, 14, 31, 0, 0).getTime();
    expect(got).toBe(expected);
  });

  test("'0 9 * * *' fires at the next local 09:00", () => {
    // Before 9am the same day:
    const beforeNine = new Date(2026, 4, 12, 7, 0, 0, 0).getTime();
    expect(nextFire({ kind: "cron", expr: "0 9 * * *" }, beforeNine)).toBe(
      new Date(2026, 4, 12, 9, 0, 0, 0).getTime(),
    );
    // After 9am -> tomorrow 9am:
    const afterNine = new Date(2026, 4, 12, 10, 0, 0, 0).getTime();
    expect(nextFire({ kind: "cron", expr: "0 9 * * *" }, afterNine)).toBe(
      new Date(2026, 4, 13, 9, 0, 0, 0).getTime(),
    );
  });

  test("'*/15 * * * *' fires at the next quarter hour", () => {
    const after = new Date(2026, 4, 12, 14, 7, 3, 0).getTime();
    expect(nextFire({ kind: "cron", expr: "*/15 * * * *" }, after)).toBe(
      new Date(2026, 4, 12, 14, 15, 0, 0).getTime(),
    );
    const after2 = new Date(2026, 4, 12, 14, 45, 0, 0).getTime();
    expect(nextFire({ kind: "cron", expr: "*/15 * * * *" }, after2)).toBe(
      new Date(2026, 4, 12, 15, 0, 0, 0).getTime(),
    );
  });

  test("explicit minute list '5,35 * * * *'", () => {
    const after = new Date(2026, 4, 12, 14, 10, 0, 0).getTime();
    expect(nextFire({ kind: "cron", expr: "5,35 * * * *" }, after)).toBe(
      new Date(2026, 4, 12, 14, 35, 0, 0).getTime(),
    );
  });

  test("day-of-month + day-of-week both restricted = either one fires (cron OR semantics)", () => {
    // "0 0 13 * 1" = midnight on the 13th OR on a Monday. 2026-05-12 is a
    // Tuesday; the 13th is Wednesday. From midday the 11th, the next fire is
    // the Monday (2026-05-11 was a Monday... pick a clean window): start late
    // on Sun 2026-05-10 -> next is Mon 2026-05-11 00:00 (Monday match),
    // well before the 13th.
    const afterSundayNight = new Date(2026, 4, 10, 23, 0, 0, 0).getTime();
    expect(nextFire({ kind: "cron", expr: "0 0 13 * 1" }, afterSundayNight)).toBe(
      new Date(2026, 4, 11, 0, 0, 0, 0).getTime(),
    );
    // From Tue afternoon the 12th, the Monday is gone — next is the 13th.
    const afterTueAfternoon = new Date(2026, 4, 12, 15, 0, 0, 0).getTime();
    expect(nextFire({ kind: "cron", expr: "0 0 13 * 1" }, afterTueAfternoon)).toBe(
      new Date(2026, 4, 13, 0, 0, 0, 0).getTime(),
    );
  });

  test("an impossible schedule returns 0 within the 366-day horizon", () => {
    // Feb 30th never exists.
    const after = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();
    expect(nextFire({ kind: "cron", expr: "0 0 30 2 *" }, after)).toBe(0);
  });
});
