import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../util/atomic-write.ts";
import { guardedFetch } from "../web/fetch.ts";

/**
 * A person's own calendar, read from the secret iCal address they choose to
 * share (Google Calendar: Settings → "Secret address in iCal format"; iCloud:
 * a public calendar link). Giving the link is the consent and deleting it in
 * their calendar app is the off switch: nothing here asks them to keep
 * anything current. Assistants that kept people engaged in 2026 were built on
 * the person's own email and calendar, not on interests guessed from chat;
 * Edmund planned trips, races and dinners the day before without knowing what
 * else was on.
 *
 * Feeds are per chat and never cross into another conversation.
 */

export type CalendarEvent = { title: string; startMs: number; endMs: number; allDay: boolean; location?: string };

type Feed = { url: string; label: string; addedMs: number };

function feedsPath(dataDir: string): string {
  return join(dataDir, "feeds", "calendars.json");
}

function readFeeds(dataDir: string): Record<string, Feed[]> {
  const path = feedsPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, Feed[]>;
  } catch {
    return {};
  }
}

export function calendarFeeds(dataDir: string, sessionKey: string): Feed[] {
  return readFeeds(dataDir)[sessionKey] ?? [];
}

export function addCalendarFeed(dataDir: string, sessionKey: string, url: string, label: string): void {
  const all = readFeeds(dataDir);
  const list = (all[sessionKey] ?? []).filter((f) => f.url !== url);
  list.push({ url, label, addedMs: Date.now() });
  all[sessionKey] = list;
  mkdirSync(join(dataDir, "feeds"), { recursive: true });
  atomicWriteFileSync(feedsPath(dataDir), `${JSON.stringify(all, null, 2)}\n`);
}

export function removeCalendarFeed(dataDir: string, sessionKey: string, label: string): boolean {
  const all = readFeeds(dataDir);
  const before = all[sessionKey]?.length ?? 0;
  all[sessionKey] = (all[sessionKey] ?? []).filter((f) => f.label !== label && f.url !== label);
  if ((all[sessionKey]?.length ?? 0) === before) return false;
  atomicWriteFileSync(feedsPath(dataDir), `${JSON.stringify(all, null, 2)}\n`);
  return true;
}

/** webcal:// is https:// with a different name. */
export function normalizeCalendarUrl(url: string): string {
  return url.trim().replace(/^webcal:\/\//i, "https://");
}

export async function fetchCalendar(url: string, timeoutMs = 15_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await guardedFetch(normalizeCalendarUrl(url), {
      signal: controller.signal,
      headers: { Accept: "text/calendar, text/plain, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("not an iCal feed");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* ── parsing ─────────────────────────────────────────────────────────────── */

type Prop = { name: string; params: Record<string, string>; value: string };

function unfold(ics: string): string[] {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseProp(line: string): Prop | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rest] = head.split(";");
  const params: Record<string, string> = {};
  for (const r of rest) {
    const eq = r.indexOf("=");
    if (eq > 0) params[r.slice(0, eq).toUpperCase()] = r.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: (name ?? "").toUpperCase(), params, value };
}

/** Epoch ms for a wall-clock time in an IANA zone, exact across DST. */
export function zonedWallClockMs(tz: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetAt = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ms));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value) % (t === "hour" ? 24 : 1e9);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - ms;
  };
  const guess = wall - offsetAt(wall);
  const exact = wall - offsetAt(guess);
  return exact + offsetAt(exact) === wall ? exact : guess;
}

const DEFAULT_TZ = "America/New_York";

function parseDate(p: Prop, fallbackTz: string): { ms: number; allDay: boolean } | null {
  const m = p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) {
    return { ms: zonedWallClockMs(fallbackTz, +y!, +mo!, +d!), allDay: true };
  }
  if (z) return { ms: Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!), allDay: false };
  let tz = p.params.TZID ?? fallbackTz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = fallbackTz;
  }
  return { ms: zonedWallClockMs(tz, +y!, +mo!, +d!, +h!, +mi!, +s!), allDay: false };
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * Occurrence start times of an RRULE within [fromMs, toMs]. Handles the
 * shapes consumer calendars write: DAILY, WEEKLY (with BYDAY), MONTHLY (same
 * day of month) and YEARLY, with INTERVAL, COUNT and UNTIL. Anything else
 * yields only the first occurrence, which is listed rather than invented.
 */
export function expandRule(
  rule: string,
  startMs: number,
  fromMs: number,
  toMs: number,
  tz: string,
): number[] {
  const r: Record<string, string> = {};
  for (const part of rule.split(";")) {
    const [k, v] = part.split("=");
    if (k && v) r[k.toUpperCase()] = v;
  }
  const interval = Math.max(1, Number(r.INTERVAL ?? 1));
  const count = r.COUNT ? Number(r.COUNT) : Number.POSITIVE_INFINITY;
  const until = r.UNTIL ? (parseDate({ name: "UNTIL", params: {}, value: r.UNTIL }, tz)?.ms ?? toMs) : Number.POSITIVE_INFINITY;
  const end = Math.min(toMs, until);
  // Wall-clock fields of the first occurrence, in its zone, so repeats keep
  // their local time across a DST change.
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date(startMs));
  const g = (t: string) => Number(f.find((p) => p.type === t)?.value) % (t === "hour" ? 24 : 1e9);
  const [y0, m0, d0, h0, mi0, s0] = [g("year"), g("month"), g("day"), g("hour"), g("minute"), g("second")];
  const at = (y: number, m: number, d: number) => zonedWallClockMs(tz, y, m, d, h0, mi0, s0);
  const out: number[] = [];
  let produced = 0;
  const take = (ms: number): boolean => {
    if (ms < startMs) return true;
    if (ms > end || produced >= count) return false;
    produced++;
    if (ms >= fromMs) out.push(ms);
    return true;
  };
  const freq = r.FREQ;
  if (freq === "DAILY" || (freq === "WEEKLY" && !r.BYDAY)) {
    const stepDays = freq === "DAILY" ? interval : 7 * interval;
    for (let i = 0; i < 5000; i++) {
      const base = new Date(Date.UTC(y0, m0 - 1, d0 + i * stepDays));
      if (!take(at(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()))) break;
    }
  } else if (freq === "WEEKLY") {
    const days = r.BYDAY!.split(",").map((d) => WEEKDAYS.indexOf(d.slice(-2))).filter((d) => d >= 0).sort();
    const startDow = new Date(Date.UTC(y0, m0 - 1, d0)).getUTCDay();
    outer: for (let w = 0; w < 1000; w++) {
      for (const dow of days) {
        const offset = w * 7 * interval + (dow - startDow);
        const base = new Date(Date.UTC(y0, m0 - 1, d0 + offset));
        const ms = at(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
        if (offset < 0) continue;
        if (!take(ms)) break outer;
      }
    }
  } else if (freq === "MONTHLY") {
    for (let i = 0; i < 1200; i++) {
      const m = m0 - 1 + i * interval;
      const y = y0 + Math.floor(m / 12);
      const mo = (m % 12) + 1;
      if (new Date(Date.UTC(y, mo - 1, d0)).getUTCMonth() !== mo - 1) continue;
      if (!take(at(y, mo, d0))) break;
    }
  } else if (freq === "YEARLY") {
    for (let i = 0; i < 200; i++) {
      if (!take(at(y0 + i * interval, m0, d0))) break;
    }
  } else {
    take(startMs);
  }
  return out;
}

/** Events overlapping [fromMs, toMs], sorted by start. */
export function parseCalendar(ics: string, fromMs: number, toMs: number): CalendarEvent[] {
  const lines = unfold(ics);
  const calTz = lines.map(parseProp).find((p) => p?.name === "X-WR-TIMEZONE")?.value || DEFAULT_TZ;
  // First pass: every VEVENT's properties. Overrides of a repeating event
  // (RECURRENCE-ID) may come before or after it, so they are known first.
  const blocks: Prop[][] = [];
  let cur: Prop[] | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = [];
    else if (line === "END:VEVENT" && cur) {
      blocks.push(cur);
      cur = null;
    } else if (cur) {
      const p = parseProp(line);
      if (p) cur.push(p);
    }
  }
  const overrides = new Set<string>();
  for (const b of blocks) {
    const rid = b.find((p) => p.name === "RECURRENCE-ID");
    const uid = b.find((p) => p.name === "UID")?.value ?? "";
    if (rid) overrides.add(`${uid}@${parseDate(rid, calTz)?.ms}`);
  }
  const events: CalendarEvent[] = [];
  for (const b of blocks) {
    const get = (n: string) => b.find((p) => p.name === n);
    const start = get("DTSTART");
    const s = start ? parseDate(start, calTz) : null;
    if (!s || get("STATUS")?.value.toUpperCase() === "CANCELLED") continue;
    const end = get("DTEND");
    const e = end ? parseDate(end, calTz) : null;
    const dur = e ? Math.max(0, e.ms - s.ms) : s.allDay ? DAY_MS : 0;
    const tz = start!.params.TZID ?? calTz;
    const title = unescape(get("SUMMARY")?.value ?? "(untitled)");
    const loc = get("LOCATION")?.value;
    const uid = get("UID")?.value ?? "";
    const rrule = get("RRULE")?.value;
    const isOverride = Boolean(get("RECURRENCE-ID"));
    const exdates = new Set(
      b
        .filter((p) => p.name === "EXDATE")
        .flatMap((p) => p.value.split(",").map((v) => parseDate({ ...p, value: v }, calTz)?.ms)),
    );
    const starts = rrule && !isOverride
      ? expandRule(rrule, s.ms, fromMs - dur, toMs, tz).filter(
          (ms) => !exdates.has(ms) && !overrides.has(`${uid}@${ms}`),
        )
      : [s.ms];
    for (const ms of starts) {
      if (ms + dur < fromMs || ms > toMs) continue;
      events.push({
        title,
        startMs: ms,
        endMs: ms + dur,
        allDay: s.allDay,
        ...(loc ? { location: unescape(loc) } : {}),
      });
    }
  }
  return events.sort((a, b) => a.startMs - b.startMs);
}

export function formatEvents(events: CalendarEvent[], tz = DEFAULT_TZ): string {
  if (events.length === 0) return "nothing on the calendar in that window";
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return events
    .map((e) => {
      const when = e.allDay
        ? `${day.format(new Date(e.startMs))} (all day)`
        : `${day.format(new Date(e.startMs))} ${time.format(new Date(e.startMs))}–${time.format(new Date(e.endMs))}`;
      return `- ${when}: ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
    })
    .join("\n");
}
