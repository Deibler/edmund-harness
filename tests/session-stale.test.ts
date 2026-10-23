/**
 * A session is stale when neither side has written for session_idle_hours.
 * It used to look at inbound only, so a group Edmund had posted in minutes
 * earlier (a reminder, a proactive message) was dropped as idle once nobody
 * had written to him for 72 hours, and the next turn started cold.
 */
import { describe, expect, test } from "bun:test";
import { isSessionStale } from "../src/boot/banner.ts";

const hours = (h: number) => Date.now() - h * 3_600_000;

describe("isSessionStale", () => {
  test("recent outbound keeps a session warm", () => {
    expect(isSessionStale({ lastInboundMs: hours(100), lastOutboundMs: hours(0.1) }, 72)).toBe(
      false,
    );
  });

  test("quiet on both sides past the limit is stale", () => {
    expect(isSessionStale({ lastInboundMs: hours(100), lastOutboundMs: hours(80) }, 72)).toBe(true);
  });

  test("no session, no record, or no limit is never stale", () => {
    expect(isSessionStale(null, 72)).toBe(false);
    expect(isSessionStale({ lastInboundMs: 0, lastOutboundMs: 0 }, 72)).toBe(false);
    expect(isSessionStale({ lastInboundMs: hours(100), lastOutboundMs: 0 }, 0)).toBe(false);
  });
});
