import type { JobSchedule } from "./types.ts";

/**
 * Accepts:
 *   "in 5 minutes" / "in 2 hours" / "in 30 seconds"
 *   "at 2026-04-19T21:00:00Z"  (ISO 8601)
 *   "every:0 9 * * *"          (prefix + 5-field cron expression)
 *   "0 9 * * *"                (bare 5-field cron)
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

  const at = s.match(/^at\s+(.+)$/i);
  if (at?.[1]) {
    const ms = Date.parse(at[1]);
    if (Number.isNaN(ms)) throw new Error(`unparseable date: ${at[1]}`);
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
