import { type ActiveHoursWindow, type BrownNosePrefs, snoozeActive } from "./prefs.ts";

/**
 * Pure picker for the ghost observer.
 *
 * Each periodic loop tick, the observer needs to decide WHICH session
 * to tick next (or none). The picker takes a snapshot of session
 * activity + prior-tick history and returns a `{ sessionKey, reason }`
 * choice based on a fixed priority order:
 *
 *   1. **window_start** — A session's active window has opened within
 *      the last `windowStartGraceMs` and we haven't ticked since the
 *      open. Catches "morning of the user's active day."
 *
 *   2. **quiet_24h** — User's last inbound was 22-26h ago AND we
 *      haven't 24h-ticked yet during this quiet stretch. Catches
 *      "user normally would have responded by now."
 *
 *   3. **quiet_4h** — User's last inbound was 4-6h ago AND we haven't
 *      4h-ticked yet during this quiet stretch. Catches "user might
 *      be done for now — anything worth surfacing before the day
 *      moves on?"
 *
 *   4. **sweep** — Oldest last-tick wins. Round-robin backstop so
 *      every session gets ghost attention even when no trigger fires.
 *
 * Higher-priority reasons short-circuit lower ones — a session that
 * just had its window open AND has been quiet for 5h is picked with
 * reason=window_start, not quiet_4h.
 *
 * Everything is pure: no IO, no Date.now() — the caller passes `nowMs`
 * so tests are deterministic.
 */

export type TickReason = "window_start" | "quiet_4h" | "quiet_24h" | "sweep";

export type SessionActivity = {
  /** Last user inbound timestamp; 0 if never. */
  lastInboundMs: number;
  /** Last model outbound; 0 if never. */
  lastOutboundMs: number;
};

export type PickerInput = {
  /** Only enabled-with-non-empty-active-hours sessions are candidates. */
  candidates: BrownNosePrefs[];
  /** sessionKey → last user inbound + last bot outbound. */
  activity: Map<string, SessionActivity>;
  /** sessionKey → last ghost tick (any reason). 0/undefined if never. */
  lastTickAtMs: Map<string, number>;
  /** sessionKey → last tick by REASON, for trigger-debouncing. */
  lastTickByReason: Map<string, Map<TickReason, number>>;
  nowMs: number;
  /** How long after a window opens we'll still consider it "just opened."
   *  Default 30 min. */
  windowStartGraceMs?: number;
  /** Floor between ticks for one session, any reason. Default 45 min —
   *  kills the post-reply + sweep stacking that burned 4 model calls in
   *  9 minutes on one quiet chat. */
  minTickSpacingMs?: number;
  /** Sweep change-gate: when NOTHING has happened in a session since its
   *  last tick, don't sweep-tick it again before this much time passes.
   *  Time-based hooks still get a daily look; the redundant every-few-
   *  hours re-derivation of the same NO stops. Default 24h. */
  staleRecheckMs?: number;
};

export type PickerResult = { sessionKey: string; reason: TickReason } | null;

export function pickNextSession(input: PickerInput): PickerResult {
  const grace = input.windowStartGraceMs ?? 30 * 60_000;
  const spacing = input.minTickSpacingMs ?? 45 * 60_000;
  const staleRecheck = input.staleRecheckMs ?? 24 * 3_600_000;

  // Global eligibility: ghost snooze (always voided by newer inbound) and
  // the per-session tick-spacing floor apply to every reason.
  const candidates = input.candidates.filter((p) => {
    const a = input.activity.get(p.sessionKey);
    if (snoozeActive(p, a?.lastInboundMs ?? 0, input.nowMs)) return false;
    const lastTick = input.lastTickAtMs.get(p.sessionKey) ?? 0;
    if (input.nowMs - lastTick < spacing) return false;
    return true;
  });

  // Priority 1: window_start
  for (const prefs of candidates) {
    const opened = windowOpenedAtMs(prefs, input.nowMs);
    if (opened === null) continue;
    const since = input.nowMs - opened;
    if (since < 0 || since > grace) continue;
    const lastWindowTick = input.lastTickByReason.get(prefs.sessionKey)?.get("window_start") ?? 0;
    if (lastWindowTick >= opened) continue; // already ticked this opening
    return { sessionKey: prefs.sessionKey, reason: "window_start" };
  }

  // Priorities 2-4 require the session to be CURRENTLY in an active
  // window — no point burning a tick just to have the ghost write
  // "outside active hours" to decisions.jsonl. window_start above is
  // exempt because windowOpenedAtMs already implies "in window".
  const inWindow = candidates.filter((p) => windowOpenedAtMs(p, input.nowMs) !== null);

  // Priority 2: quiet_24h
  for (const prefs of inWindow) {
    const a = input.activity.get(prefs.sessionKey);
    if (!a || a.lastInboundMs === 0) continue;
    const quiet = input.nowMs - a.lastInboundMs;
    if (quiet < 22 * 3_600_000 || quiet > 26 * 3_600_000) continue;
    const lastQuiet24 = input.lastTickByReason.get(prefs.sessionKey)?.get("quiet_24h") ?? 0;
    // Only trigger once per quiet stretch — if we've ticked within the
    // last 22h with reason=quiet_24h, skip.
    if (input.nowMs - lastQuiet24 < 22 * 3_600_000) continue;
    return { sessionKey: prefs.sessionKey, reason: "quiet_24h" };
  }

  // Priority 3: quiet_4h
  for (const prefs of inWindow) {
    const a = input.activity.get(prefs.sessionKey);
    if (!a || a.lastInboundMs === 0) continue;
    const quiet = input.nowMs - a.lastInboundMs;
    if (quiet < 4 * 3_600_000 || quiet > 6 * 3_600_000) continue;
    const lastQuiet4 = input.lastTickByReason.get(prefs.sessionKey)?.get("quiet_4h") ?? 0;
    if (input.nowMs - lastQuiet4 < 4 * 3_600_000) continue;
    return { sessionKey: prefs.sessionKey, reason: "quiet_4h" };
  }

  // Priority 4: sweep — oldest last-tick among in-window candidates.
  // Change-gate: a session where nothing has happened since its last tick
  // is only re-swept after staleRecheck (default 24h) — re-deriving the
  // same NO every few hours against a quiet chat is pure waste. New
  // activity (either direction) makes it immediately sweepable again.
  if (inWindow.length === 0) return null;
  let best: BrownNosePrefs | null = null;
  let bestLast = Number.POSITIVE_INFINITY;
  for (const prefs of inWindow) {
    const last = input.lastTickAtMs.get(prefs.sessionKey) ?? 0;
    if (last > 0) {
      const a = input.activity.get(prefs.sessionKey);
      const newActivity = Math.max(a?.lastInboundMs ?? 0, a?.lastOutboundMs ?? 0) > last;
      if (!newActivity && input.nowMs - last < staleRecheck) continue;
    }
    if (last < bestLast) {
      bestLast = last;
      best = prefs;
    }
  }
  return best ? { sessionKey: best.sessionKey, reason: "sweep" } : null;
}

/**
 * If `nowMs` falls within an active-hours window for this session,
 * return the unix-ms at which that window opened. Otherwise null.
 *
 * Used by the window_start trigger: "just-opened" means the open
 * timestamp is recent (within the grace period).
 */
export function windowOpenedAtMs(prefs: BrownNosePrefs, nowMs: number): number | null {
  if (prefs.activeHours.length === 0) return null;
  const local = localDayAndMinutes(nowMs, prefs.timezone);
  for (const w of prefs.activeHours) {
    if (w.dow !== local.dow) continue;
    const start = parseHHMM(w.start);
    const end = parseHHMM(w.end);
    if (start === null || end === null) continue;
    if (local.minutes < start || local.minutes >= end) continue;
    // We're inside this window. Compute the unix-ms it opened.
    const minutesIntoWindow = local.minutes - start;
    return nowMs - minutesIntoWindow * 60_000 - local.secondsAndMs;
  }
  return null;
}

// ---- internal helpers (mirror budget.ts; kept local so picker is
// self-contained for testing) ----

function localDayAndMinutes(
  ms: number,
  timezone: string,
): { dow: ActiveHoursWindow["dow"]; minutes: number; secondsAndMs: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  let dow: ActiveHoursWindow["dow"] = "mon";
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const p of parts) {
    if (p.type === "weekday") dow = (p.value.toLowerCase() as ActiveHoursWindow["dow"]) || "mon";
    else if (p.type === "hour") hour = (Number.parseInt(p.value, 10) || 0) % 24;
    else if (p.type === "minute") minute = Number.parseInt(p.value, 10) || 0;
    else if (p.type === "second") second = Number.parseInt(p.value, 10) || 0;
  }
  return {
    dow,
    minutes: hour * 60 + minute,
    secondsAndMs: second * 1000 + (ms % 1000),
  };
}

function parseHHMM(s: string): number | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number.parseInt(m[1]!, 10);
  const min = Number.parseInt(m[2]!, 10);
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
