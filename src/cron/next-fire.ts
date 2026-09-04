import type { JobSchedule } from "./types.ts";

/**
 * Compute the next fire timestamp (unix ms).
 *
 * For one-shots: if `atMs` is in the future, returns it. If `atMs` is in
 * the past (or equal to `after`), returns `after` — i.e. "fire now". This
 * lets callers like the relay schedule at `Date.now()` exactly without
 * needing a "+1s" cushion, and ensures a missed one-shot (daemon was down
 * when atMs passed) still fires on next poll. Only returns 0 if atMs is
 * literally 0 / negative (a real invalid input).
 *
 * For cron, walks minute-by-minute up to 366 days out.
 */
export function nextFire(schedule: JobSchedule, after: number): number {
  if (schedule.kind === "once") {
    if (schedule.atMs <= 0) return 0;
    return Math.max(schedule.atMs, after);
  }
  return nextCronFire(schedule.expr, after);
}

type FieldSet = { any: boolean; values: Set<number> };

function nextCronFire(expr: string, after: number): number {
  const [minF, hourF, domF, monthF, dowF] = expr.split(/\s+/).map((f) => parseField(f));
  // Shouldn't happen — parseSchedule validates 5 fields — but TS needs the guard.
  if (!minF || !hourF || !domF || !monthF || !dowF) {
    throw new Error(`invalid cron expression: ${expr}`);
  }

  // Round up to the next whole minute after `after`.
  const start = new Date(after + 60_000);
  start.setSeconds(0, 0);

  const limitMs = after + 366 * 86_400_000;
  for (let ms = start.getTime(); ms < limitMs; ms += 60_000) {
    const d = new Date(ms);
    if (!matches(minF, d.getMinutes())) continue;
    if (!matches(hourF, d.getHours())) continue;
    if (!matches(monthF, d.getMonth() + 1)) continue;
    const domOk = matches(domF, d.getDate());
    const dowOk = matches(dowF, d.getDay()); // 0=Sun
    // cron semantics: if both day fields are restricted, either one matching wins.
    if (!domF.any && !dowF.any) {
      if (!domOk && !dowOk) continue;
    } else {
      if (!domOk || !dowOk) continue;
    }
    return ms;
  }
  return 0;
}

function parseField(field: string): FieldSet | null {
  if (field === "*") return { any: true, values: new Set() };
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const body = stepMatch?.[1] ?? part;
    const step = stepMatch?.[2] ? Number.parseInt(stepMatch[2], 10) : 1;
    const rangeMatch = body.match(/^(\d+)-(\d+)$/);
    if (rangeMatch?.[1] && rangeMatch[2]) {
      const a = Number.parseInt(rangeMatch[1], 10);
      const b = Number.parseInt(rangeMatch[2], 10);
      for (let v = a; v <= b; v += step) values.add(v);
    } else if (body === "*") {
      // e.g. "*/5" — caller range applied at match time via modulo.
      // Simpler: expand to concrete range. But without field bounds we can't.
      // We encode step-of-star as a special flag by adding 10000 base + step.
      values.add(-step);
    } else {
      values.add(Number.parseInt(body, 10));
    }
  }
  return { any: false, values };
}

function matches(f: FieldSet, v: number): boolean {
  if (f.any) return true;
  if (f.values.has(v)) return true;
  for (const entry of f.values) {
    if (entry < 0 && v % -entry === 0) return true; // */N
  }
  return false;
}
