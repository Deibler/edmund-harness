/**
 * One canonical, timezone-pinned wall clock for everything the model reads.
 *
 * The owner lives in Lancaster, PA (US Eastern). Every model-facing timestamp
 * — the inbound iMessage envelope stamp, reminder confirmations, listed jobs —
 * must read the SAME wall clock the user does, and must do so regardless of the
 * host process's TZ.
 *
 * History / why this exists: the inbound envelope used to build its date with
 * `new Date().toISOString().slice(0,10)` (UTC) while the weekday and clock came
 * from `getHours()`/`toLocaleDateString()` (host-local). After ~8pm Eastern the
 * UTC date had already rolled to the next day, so the model was handed a stamp
 * like "Mon 2026-06-30 21:38" — weekday Monday but a Tuesday's date. Trusting
 * that date, it computed "tomorrow" one day too far out and scheduled every
 * evening reminder a day late (silently: the job sat active for the wrong day).
 *
 * Pinning to a single IANA zone via Intl kills that whole class of bug: the
 * date, weekday, and time all come from the same zone, so they can never
 * disagree, and it no longer matters what TZ the process runs in.
 *
 * Keep HOME_TZ in sync with config `[owner].timezone`.
 */
const HOME_TZ = "America/New_York";

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/**
 * Compact stamp for the inbound envelope header: `Mon 2026-06-29 21:38 EDT`.
 * 24-hour clock, ISO-style numeric date, always Eastern. The trailing zone
 * abbreviation makes the timezone explicit to the model.
 */
export function envelopeStamp(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOME_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(d);
  // Older ICU renders midnight as "24"; normalize to "00".
  let hour = part(parts, "hour");
  if (hour === "24") hour = "00";
  return `${part(parts, "weekday")} ${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")} ${hour}:${part(parts, "minute")} ${part(parts, "timeZoneName")}`;
}

/**
 * Human, self-verifiable form for tool output: `Mon, Jun 29 2026 at 9:38 PM EDT`.
 * 12-hour clock so "time of day" is unambiguous.
 */
export function describeEastern(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOME_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(d);
  return `${part(parts, "weekday")}, ${part(parts, "month")} ${part(parts, "day")} ${part(parts, "year")} at ${part(parts, "hour")}:${part(parts, "minute")} ${part(parts, "dayPeriod")} ${part(parts, "timeZoneName")}`;
}

/** Eastern calendar date, `YYYY-MM-DD`. Use for dated note/memory stamps so an
 *  evening entry gets today's Eastern date, not tomorrow's UTC date. */
export function easternDate(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOME_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

/** Eastern date + 24h clock, `YYYY-MM-DD HH:MM`. Same-zone date and time (the
 *  old `toISOString()` date + `toTimeString()` time mixed UTC and local). */
export function easternDateTime(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOME_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  let hour = part(parts, "hour");
  if (hour === "24") hour = "00";
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")} ${hour}:${part(parts, "minute")}`;
}

/** Just the time-of-day in Eastern: `9:00 AM EDT`. */
export function timeOfDayEastern(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOME_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(d);
  return `${part(parts, "hour")}:${part(parts, "minute")} ${part(parts, "dayPeriod")} ${part(parts, "timeZoneName")}`;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = [
  "",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function dowNames(field: string): string {
  return field
    .split(",")
    .map((v) => DOW[Number(v) % 7] ?? v)
    .join("/");
}

function monthNames(field: string): string {
  return field
    .split(",")
    .map((v) => MON[Number(v)] ?? v)
    .join("/");
}

/**
 * Best-effort plain-English cadence for a recurring (cron) job, e.g.
 * "every day at 9:00 AM EDT" or "every Sun at 6:00 PM EST". The time of day is
 * taken from `sampleFireMs` (the job's next concrete fire) so it always matches
 * the real fire time; the day pattern comes from the cron fields. Anything the
 * simple cases don't cover falls back to showing the raw expression.
 */
export function describeCadence(expr: string, sampleFireMs: number): string {
  const f = expr.split(/\s+/);
  const [mi, ho, dom, mon, dow] = f;
  if (f.length !== 5) return `on cron schedule "${expr}"`;
  const tod = timeOfDayEastern(new Date(sampleFireMs));
  const fixedTime = /^\d+$/.test(mi ?? "") && /^\d+$/.test(ho ?? "");
  if (fixedTime && dom === "*" && mon === "*" && dow === "*") return `every day at ${tod}`;
  if (fixedTime && dom === "*" && mon === "*" && dow !== "*")
    return `every ${dowNames(dow ?? "")} at ${tod}`;
  if (fixedTime && dom !== "*" && dow === "*" && mon === "*")
    return `on day ${dom} of each month at ${tod}`;
  if (fixedTime && mon !== "*" && dom !== "*" && dow === "*")
    return `on ${monthNames(mon ?? "")} ${dom} at ${tod}`;
  return `on cron schedule "${expr}" (next at ${tod})`;
}

/** Signed, human duration between two instants: "in 11h 22m" / "5m ago". */
export function humanDelta(fromMs: number, toMs: number): string {
  let s = Math.round((toMs - fromMs) / 1000);
  const past = s < 0;
  s = Math.abs(s);
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const bits: string[] = [];
  if (d) bits.push(`${d}d`);
  if (h) bits.push(`${h}h`);
  if (m || bits.length === 0) bits.push(`${m}m`);
  const body = bits.join(" ");
  return past ? `${body} ago` : `in ${body}`;
}

/**
 * Coarse age of an instant, for labelling recalled memory: "6 weeks ago".
 *
 * Recall lines already carry an absolute date, and that was not enough — the
 * model has to work out what "2026-06-15" means relative to now, and it got it
 * wrong out loud, opening a conversation with a six-week-old item as though it
 * were from Tuesday. Stating the age removes the arithmetic.
 *
 * Deliberately coarse. Nothing downstream needs minutes on a month-old message,
 * and "44d 3h 12m ago" reads as precision about something that is simply old.
 */
export function humanAge(ms: number, nowMs: number = Date.now()): string {
  const delta = Math.max(0, nowMs - ms);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(delta / 86_400_000);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} months ago`;
  return `${Math.round(days / 365)} years ago`;
}
