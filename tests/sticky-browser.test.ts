/**
 * A session that needed the browser keeps it on its next spawns for a day,
 * so an evicted worker's successor does not start without it and recycle
 * on the next link (65 such recycles 10-20 to 10-29; 37 in sessions that
 * had needed the browser within the previous day).
 */
import { describe, expect, test } from "bun:test";
import { stickyBrowser } from "../src/claude/runner.ts";

describe("stickyBrowser", () => {
  test("keeps the browser for a day after the session needed it", () => {
    const t0 = 1_800_000_000_000;
    const key = "imessage:dm:+15550100081";
    expect(stickyBrowser(key, false, t0)).toBe(false);
    expect(stickyBrowser(key, true, t0)).toBe(true);
    expect(stickyBrowser(key, false, t0 + 60 * 60_000)).toBe(true);
    expect(stickyBrowser(key, false, t0 + 25 * 60 * 60_000)).toBe(false);
    expect(stickyBrowser("imessage:dm:+15550100082", false, t0)).toBe(false);
  });
});
