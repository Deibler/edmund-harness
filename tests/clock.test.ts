/**
 * Home-timezone clock. The regression these lock down: the inbound envelope
 * stamp must read the owner's Eastern wall clock, with weekday + date + time
 * all from the SAME zone, regardless of the host process TZ.
 *
 * The original bug built the date from `toISOString()` (UTC) while the weekday
 * and clock were host-local. After 8pm Eastern the UTC date had already rolled
 * over, so the stamp said e.g. "Mon 2026-06-30 21:38" — a Monday weekday glued
 * to a Tuesday's date — and the model, trusting that date, scheduled Pat's
 * "remind me tomorrow" reminders a full day late.
 */
import { describe, expect, test } from "bun:test";
import {
  describeCadence,
  describeEastern,
  easternDate,
  easternDateTime,
  envelopeStamp,
  humanDelta,
  timeOfDayEastern,
} from "../src/util/clock.ts";

describe("envelopeStamp (Eastern, TZ-pinned)", () => {
  test("the exact instant that misfired Pat's reminder: Mon 9:38pm EDT, not Tue", () => {
    // 2026-06-30T01:38:00Z == 2026-06-29 21:38 EDT (Monday night).
    // Old code emitted "Mon 2026-06-30 21:38" (UTC date, a day ahead).
    const stamp = envelopeStamp(new Date("2026-06-30T01:38:00Z"));
    expect(stamp).toBe("Mon 2026-06-29 21:38 EDT");
    // The date component must agree with the weekday — never a day ahead.
    expect(stamp).not.toContain("2026-06-30");
  });

  test("afternoon (UTC date == local date) is unaffected", () => {
    // 2026-06-29T20:11Z == 2026-06-29 16:11 EDT.
    expect(envelopeStamp(new Date("2026-06-29T20:11:00Z"))).toBe("Mon 2026-06-29 16:11 EDT");
  });

  test("winter instant reports EST", () => {
    // 2026-01-05T02:00:00Z == 2026-01-04 21:00 EST (Sunday night).
    expect(envelopeStamp(new Date("2026-01-05T02:00:00Z"))).toBe("Sun 2026-01-04 21:00 EST");
  });

  test("does not leak the host process TZ", () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = "UTC"; // even on a UTC host, the stamp stays Eastern
      expect(envelopeStamp(new Date("2026-06-30T01:38:00Z"))).toBe("Mon 2026-06-29 21:38 EDT");
    } finally {
      process.env.TZ = saved;
    }
  });
});

describe("describeEastern (human, self-verifiable)", () => {
  test("renders 12-hour Eastern with weekday, date, and zone", () => {
    expect(describeEastern(new Date("2026-06-30T01:38:00Z"))).toBe(
      "Mon, Jun 29 2026 at 9:38 PM EDT",
    );
  });
});

describe("describeCadence", () => {
  const sampleNine = new Date("2026-06-30T13:00:00Z").getTime(); // 9:00 AM EDT

  test("daily", () => {
    expect(describeCadence("0 9 * * *", sampleNine)).toBe("every day at 9:00 AM EDT");
  });
  test("weekly", () => {
    expect(describeCadence("0 9 * * 1", sampleNine)).toBe("every Mon at 9:00 AM EDT");
  });
  test("monthly", () => {
    expect(describeCadence("0 9 5 * *", sampleNine)).toBe("on day 5 of each month at 9:00 AM EDT");
  });
  test("unusual expr falls back to the raw cron", () => {
    expect(describeCadence("*/15 * * * *", sampleNine)).toContain('cron schedule "*/15 * * * *"');
  });
});

describe("easternDate / easternDateTime (dated note stamps)", () => {
  test("evening Eastern stamps today's Eastern date, not tomorrow's UTC date", () => {
    // 2026-06-30T01:38:00Z == 2026-06-29 21:38 EDT. The old toISOString()
    // stamp would have written "2026-06-30" onto a note made Monday night.
    expect(easternDate(new Date("2026-06-30T01:38:00Z"))).toBe("2026-06-29");
    expect(easternDateTime(new Date("2026-06-30T01:38:00Z"))).toBe("2026-06-29 21:38");
  });

  test("midnight rollover renders 00:00, not 24:00", () => {
    // 2026-06-30T04:00:00Z == 2026-06-30 00:00 EDT.
    expect(easternDate(new Date("2026-06-30T04:00:00Z"))).toBe("2026-06-30");
    expect(easternDateTime(new Date("2026-06-30T04:00:00Z"))).toBe("2026-06-30 00:00");
  });

  test("does not leak the host process TZ", () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      expect(easternDate(new Date("2026-06-30T01:38:00Z"))).toBe("2026-06-29");
    } finally {
      process.env.TZ = saved;
    }
  });
});

describe("humanDelta", () => {
  test("future", () => {
    expect(humanDelta(0, (11 * 3600 + 22 * 60) * 1000)).toBe("in 11h 22m");
  });
  test("past", () => {
    expect(humanDelta(5 * 60_000, 0)).toBe("5m ago");
  });
  test("timeOfDayEastern is just the clock + zone", () => {
    expect(timeOfDayEastern(new Date("2026-06-30T13:00:00Z"))).toBe("9:00 AM EDT");
  });
});
