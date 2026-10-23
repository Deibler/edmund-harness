/**
 * parseSchedule takes the timestamps the model actually sends. Bare ISO (no
 * "at") was 32 of the 47 schedule_reminder failures in the daemon log
 * (2026-10-23), and a time written without an offset means Eastern, not the
 * process's zone.
 */
import { describe, expect, test } from "bun:test";
import { parseSchedule } from "../src/cron/parse.ts";
import { homeWallClockMs } from "../src/util/clock.ts";

const once = (s: string) => {
  const r = parseSchedule(s);
  if (r.kind !== "once") throw new Error(`not once: ${s}`);
  return r.atMs;
};

describe("absolute times", () => {
  test("bare ISO with an offset, with or without the colon or seconds", () => {
    const want = Date.UTC(2026, 9, 22, 11, 30);
    expect(once("2026-10-22T07:30:00-04:00")).toBe(want);
    expect(once("2026-10-22T07:30-0400")).toBe(want);
    expect(once("2026-10-22 07:30:00-04:00")).toBe(want);
    expect(once("2026-10-22T11:30:00Z")).toBe(want);
    expect(once("at 2026-10-22T07:30:00-04:00")).toBe(want);
  });

  test("no offset means Eastern, on both sides of the DST change", () => {
    expect(once("2026-10-22 07:30")).toBe(Date.UTC(2026, 9, 22, 11, 30)); // EDT
    expect(once("2026-11-16 12:30")).toBe(Date.UTC(2026, 10, 16, 17, 30)); // EST
    expect(once("at 2026-11-16T12:30")).toBe(Date.UTC(2026, 10, 16, 17, 30));
  });

  test("other forms are untouched", () => {
    expect(parseSchedule("0 9 * * *")).toEqual({ kind: "cron", expr: "0 9 * * *" });
    const now = 1_800_000_000_000;
    expect(parseSchedule("in 5 minutes", now)).toEqual({ kind: "once", atMs: now + 300_000 });
    expect(() => parseSchedule("today at 9pm")).toThrow();
    expect(() => parseSchedule("2026-13-45 99:99")).toThrow();
  });
});

describe("homeWallClockMs", () => {
  test("the DST boundaries resolve to the right instant", () => {
    // 2026-11-01 01:30 happens twice; the first (EDT) is taken.
    expect(homeWallClockMs(2026, 11, 1, 1, 30)).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(homeWallClockMs(2026, 11, 1, 3, 0)).toBe(Date.UTC(2026, 10, 1, 8, 0));
    expect(homeWallClockMs(2026, 3, 8, 12, 0)).toBe(Date.UTC(2026, 2, 8, 16, 0));
  });
});
