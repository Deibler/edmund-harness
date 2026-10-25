import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addCalendarFeed,
  calendarFeeds,
  expandRule,
  formatEvents,
  normalizeCalendarUrl,
  parseCalendar,
  removeCalendarFeed,
  zonedWallClockMs,
} from "../src/feeds/calendar.ts";

const dir = mkdtempSync(join(tmpdir(), "calendar-feed-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ICS = [
  "BEGIN:VCALENDAR",
  "X-WR-TIMEZONE:America/New_York",
  "BEGIN:VEVENT",
  "UID:run",
  "DTSTART;TZID=America/New_York:20261027T063000",
  "DTEND;TZID=America/New_York:20261027T073000",
  "RRULE:FREQ=WEEKLY;BYDAY=TU,TH",
  "EXDATE;TZID=America/New_York:20261029T063000",
  "SUMMARY:Easy run",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:run",
  "RECURRENCE-ID;TZID=America/New_York:20261103T063000",
  "DTSTART;TZID=America/New_York:20261103T070000",
  "DTEND;TZID=America/New_York:20261103T080000",
  "SUMMARY:Easy run (moved)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:race",
  "DTSTART;VALUE=DATE:20261114",
  "DTEND;VALUE=DATE:20261115",
  "SUMMARY:Race day",
  "LOCATION:Philadelphia\\, PA",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:call",
  "DTSTART:20261028T150000Z",
  "DTEND:20261028T153000Z",
  "SUMMARY:Recruiter call",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:gone",
  "DTSTART:20261028T170000Z",
  "STATUS:CANCELLED",
  "SUMMARY:Cancelled thing",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const from = Date.UTC(2026, 9, 26);
const to = Date.UTC(2026, 10, 16);

describe("a person's own calendar", () => {
  test("wall-clock times convert across the daylight saving change", () => {
    expect(zonedWallClockMs("America/New_York", 2026, 10, 27, 6, 30)).toBe(
      Date.UTC(2026, 9, 27, 10, 30),
    );
    expect(zonedWallClockMs("America/New_York", 2026, 11, 3, 6, 30)).toBe(
      Date.UTC(2026, 10, 3, 11, 30),
    );
  });

  test("weekly repeats keep their local time, skip excluded dates and honour moved ones", () => {
    const runs = parseCalendar(ICS, from, to).filter((e) => e.title.startsWith("Easy run"));
    const starts = runs.map((e) => new Date(e.startMs).toISOString().slice(0, 16));
    expect(starts).toContain("2026-10-27T10:30");
    expect(starts).not.toContain("2026-10-29T10:30"); // excluded
    expect(starts).toContain("2026-11-03T12:00"); // moved to 07:00 EST
    expect(starts).not.toContain("2026-11-03T11:30"); // the original slot is gone
    expect(starts).toContain("2026-11-05T11:30"); // 06:30 EST after the change
    expect(runs.find((e) => e.title === "Easy run (moved)")).toBeDefined();
  });

  test("all-day events, plain UTC events and locations; cancelled events are dropped", () => {
    const events = parseCalendar(ICS, from, to);
    const race = events.find((e) => e.title === "Race day");
    expect(race?.allDay).toBe(true);
    expect(race?.location).toBe("Philadelphia, PA");
    expect(events.find((e) => e.title === "Recruiter call")?.startMs).toBe(
      Date.UTC(2026, 9, 28, 15),
    );
    expect(events.find((e) => e.title === "Cancelled thing")).toBeUndefined();
  });

  test("the window is honoured", () => {
    const narrow = parseCalendar(ICS, Date.UTC(2026, 9, 28), Date.UTC(2026, 9, 29));
    expect(narrow.map((e) => e.title)).toEqual(["Recruiter call"]);
  });

  test("COUNT and UNTIL end a series", () => {
    const start = Date.UTC(2026, 9, 1, 12);
    expect(
      expandRule("FREQ=DAILY;COUNT=3", start, start, start + 30 * 86_400_000, "UTC"),
    ).toHaveLength(3);
    expect(
      expandRule("FREQ=DAILY;UNTIL=20261005T235959Z", start, start, start + 30 * 86_400_000, "UTC"),
    ).toHaveLength(5);
    expect(expandRule("FREQ=MONTHLY", start, start, start + 95 * 86_400_000, "UTC")).toHaveLength(
      4,
    );
  });

  test("events read as plain lines in Eastern time", () => {
    const text = formatEvents(parseCalendar(ICS, Date.UTC(2026, 9, 28), Date.UTC(2026, 9, 29)));
    expect(text).toContain("Recruiter call");
    expect(text).toContain("11:00");
    expect(formatEvents([])).toContain("nothing on the calendar");
  });

  test("feeds are kept per chat; webcal links become https", () => {
    addCalendarFeed(
      dir,
      "dm:+15555550101",
      normalizeCalendarUrl("webcal://example.com/a.ics"),
      "work",
    );
    expect(calendarFeeds(dir, "dm:+15555550101")[0]?.url).toBe("https://example.com/a.ics");
    expect(calendarFeeds(dir, "dm:+15555550102")).toEqual([]);
    expect(removeCalendarFeed(dir, "dm:+15555550101", "work")).toBe(true);
    expect(calendarFeeds(dir, "dm:+15555550101")).toEqual([]);
  });
});
