import { homeWallClockMs } from "../util/clock.ts";
import type { JobSchedule } from "./types.ts";

/**
 * Accepts:
 *   "in 5 minutes" / "in 2 hours" / "in 30 seconds"
 *   "at 2026-04-19T21:00:00Z"  (ISO 8601)
 *   "2026-04-19T21:00:00-04:00" / "2026-04-19 21:00"  (bare ISO, no "at")
 *   "every:0 9 * * *"          (prefix + 5-field cron expression)
 *   "0 9 * * *"                (bare 5-field cron)
 *
 * A date-time with no offset is Eastern (the home zone), not the process's
 * zone. Bare ISO was 32 of the 47 schedule failures in the daemon log
 * (2026-10-23): the model leaves "at" off a timestamp it wrote correctly.
 */
export function parseSchedule(input: string, now = Date.now()): JobSchedule {
  const s = input.trim();

  const rel = s.match(
    /^in\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i,
  );
  if (rel?.[1] && rel[2]) {
    const n = Number.parseInt(rel[1], 10);
    const unitMs = unitToMs(rel[2]);
    return { kind: "once", atMs: now + n * unitMs };
  }

  const at = s.match(/^at\s+(.+)$/i)?.[1] ?? (ISO_DATE_TIME.test(s) ? s : null);
  if (at) {
    const ms = parseDateTime(at);
    if (Number.isNaN(ms)) throw new Error(`unparseable date: ${at}`);
    return { kind: "once", atMs: ms };
  }

  const cronPrefixed = s.match(/^every:\s*(.+)$/i);
  const expr = cronPrefixed?.[1] ?? (looksLikeCron(s) ? s : null);
  if (expr) {
    validateCronExpr(expr);
    return { kind: "cron", expr };
  }

  throw new Error(`unparseable schedule: ${input}`);
}

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

function parseDateTime(text: string): number {
  const t = text.trim();
  const m = t.match(ISO_DATE_TIME);
  if (!m) return Date.parse(t);
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map((v) => Number(v ?? 0)) as number[];
  // Date.UTC rolls month 13 or Feb 30 over into a real date; refuse them.
  const day = new Date(Date.UTC(y!, mo! - 1, d!));
  if (day.getUTCMonth() !== mo! - 1 || day.getUTCDate() !== d! || h! > 23 || mi! > 59 || sec! > 59)
    return Number.NaN;
  const zone = m[7];
  if (!zone) return homeWallClockMs(y!, mo!, d!, h!, mi!, sec!);
  const offset = /^[+-]\d{4}$/.test(zone) ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const pad = (n: number) => String(n).padStart(2, "0");
  return Date.parse(`${y}-${pad(mo!)}-${pad(d!)}T${pad(h!)}:${pad(mi!)}:${pad(sec!)}${offset}`);
}

function unitToMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("s")) return 1000;
  if (u.startsWith("m") && !u.startsWith("mo")) return 60_000;
  if (u.startsWith("h")) return 3_600_000;
  if (u.startsWith("d")) return 86_400_000;
  throw new Error(`unknown unit: ${unit}`);
}

function looksLikeCron(s: string): boolean {
  return s.split(/\s+/).length === 5;
}

function validateCronExpr(expr: string): void {
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must be 5 fields, got ${fields.length}`);
  // Basic structural check; full semantic validation happens in nextFire.
  for (const f of fields) {
    if (!/^[\d,\-*/]+$/.test(f)) throw new Error(`invalid cron field: ${f}`);
  }
}
