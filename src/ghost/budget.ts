import { resolveIntensity } from "./intensity.ts";
import type { ActiveHoursWindow, BrownNosePrefs, FireRecord, FocusSuggestion } from "./prefs.ts";

/**
 * Pure budget logic for the ghost. Every gate the system applies before
 * even considering a Haiku call lives here as a deterministic function.
 *
 * The flow at ghost-tick time is:
 *   1. checkEnabled         — kill switch + per-session enable
 *   2. checkActiveHours     — TZ-aware, day-of-week aware
 *   3. checkCooldown        — last-fire cooldown (intensity + decay)
 *   4. checkWeeklyCap       — fires in trailing 7 days vs cap
 *   5. decayMultiplier      — engagement-history derived multiplier on cooldown
 *   6. focusSuggestionStatus — per-topic 3-use-per-week cap status
 *
 * None of these functions read state.db or call the LLM. They're fed
 * data and return decisions, which makes them trivially unit-testable.
 *
 * Each `check*` returns either `{ ok: true }` or
 * `{ ok: false, reason: string }`. The ghost think() module short-
 * circuits on the first false and writes the reason to decisions.jsonl
 * so the operator can read why a tick produced nothing.
 */

export type GateResult = { ok: true } | { ok: false; reason: string };

export function checkEnabled(prefs: BrownNosePrefs, globalEnabled: boolean): GateResult {
  if (!globalEnabled) return { ok: false, reason: "global brown_nose disabled" };
  if (!prefs.enabled) {
    return {
      ok: false,
      reason: prefs.disabledReason
        ? `session disabled: ${prefs.disabledReason}`
        : "session disabled",
    };
  }
  return { ok: true };
}

/**
 * Is `nowMs` inside any of the session's active-hours windows, in the
 * session's timezone? Uses Intl.DateTimeFormat to get TZ-local day and
 * time without bringing in moment/luxon.
 */
export function checkActiveHours(prefs: BrownNosePrefs, nowMs: number): GateResult {
  if (prefs.activeHours.length === 0) {
    return { ok: false, reason: "no active hours configured" };
  }
  const local = localDayAndMinutes(nowMs, prefs.timezone);
  for (const w of prefs.activeHours) {
    if (w.dow !== local.dow) continue;
    const start = parseHHMM(w.start);
    const end = parseHHMM(w.end);
    if (start === null || end === null) continue;
    if (local.minutes >= start && local.minutes < end) return { ok: true };
  }
  return {
    ok: false,
    reason: `outside active hours (${local.dow} ${formatMinutes(local.minutes)} ${prefs.timezone})`,
  };
}

/**
 * Has enough time passed since the last fire to satisfy cooldown? The
 * effective cooldown is `intensity.cooldownHours * decayMultiplier`.
 * `recentFires` should be sorted newest-first (which prefsStore.recentFires
 * returns by default).
 */
/**
 * Deterministic per-fire jitter factor in [1.0, 3.0]. A FIXED cooldown
 * makes proactive contact land on a predictable rhythm — which reads as
 * a notification schedule, not a friend. Seeding from the fire id keeps
 * the factor stable across checks (no flapping) while making the gap
 * after every fire genuinely different.
 */
export function cooldownJitterFactor(seed: number): number {
  // xorshift-style scramble → [0,1) → [1,3)
  let x = (seed | 0) + 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = (x ^ (x >>> 15)) >>> 0;
  return 1 + (x / 0xffffffff) * 2;
}

export function checkCooldown(
  prefs: BrownNosePrefs,
  recentFires: FireRecord[],
  intensity: number,
  nowMs: number,
): GateResult {
  if (recentFires.length === 0) return { ok: true };
  const last = recentFires[0]!;
  const params = resolveIntensity(intensity);
  const jitter = cooldownJitterFactor(last.id);
  const cooldownMs = params.cooldownHours * 3_600_000 * prefs.cooldownMultiplier * jitter;
  const elapsed = nowMs - last.firedAtMs;
  if (elapsed >= cooldownMs) return { ok: true };
  const remaining = cooldownMs - elapsed;
  return {
    ok: false,
    reason: `cooldown active (${formatDurationMs(remaining)} remaining, ${(params.cooldownHours * jitter).toFixed(1)}h effective: ${prefs.cooldownMultiplier.toFixed(1)}× decay · ${jitter.toFixed(2)}× jitter)`,
  };
}

/**
 * ONE OPEN PROACTIVE THREAD AT A TIME — the strongest anti-spam rule in
 * the system. If the most recent fire is still unanswered (outcome
 * pending AND no user message since it fired), the ghost may not fire
 * again, full stop. Stacked unprompted messages into silence is exactly
 * the engagement-farming feel the operator banned; the outcome sweeper
 * resolves the verdict within 36h (engaged/ignored) and normal pacing —
 * with decay if ignored — resumes from there.
 */
export function checkOutstandingFire(recentFires: FireRecord[], lastInboundMs: number): GateResult {
  const last = recentFires[0];
  if (!last) return { ok: true };
  if (last.outcome !== null) return { ok: true };
  if (lastInboundMs > last.firedAtMs) return { ok: true };
  return {
    ok: false,
    reason: `outstanding proactive thread — last fire (${formatDurationMs(Date.now() - last.firedAtMs)} ago) is unanswered; never stack proactive messages into silence`,
  };
}

/** Fires in trailing 7 days vs the session's `weeklyCap`. */
export function checkWeeklyCap(prefs: BrownNosePrefs, weekFires: FireRecord[]): GateResult {
  if (weekFires.length < prefs.weeklyCap) return { ok: true };
  return {
    ok: false,
    reason: `weekly cap hit (${weekFires.length}/${prefs.weeklyCap})`,
  };
}

/**
 * Engagement-decay multiplier derived from recent outcomes.
 *
 *   0 negative in last 5 → 1.0 (no decay)
 *   1 negative           → 1.5
 *   2 negative           → 2.0
 *   3 negative           → 3.0
 *   4+ negative          → 4.0 (capped)
 *
 * "Negative" means outcome === "ignored", "pushed_back", or a 👎
 * tapback ("reacted" with negative glyph). Outcomes still null (no user
 * response yet) don't count either way. Outcomes are stamped by the
 * deterministic backfill sweep (ghost/outcomes.ts); pushed_back is
 * stamped by the disable_brown_nose handler.
 *
 * Positive reinforcement: a clean recent record (3+ positive — engaged
 * or a warm tapback — with zero negative in the window) EARNS a shorter
 * cooldown (0.75×) — proactive moves that demonstrably land should come
 * a bit more often, not just avoid punishment. A ❓ tapback is neutral:
 * neither warmth nor rejection, just confusion.
 *
 * Returns the multiplier so callers can write it into prefs.
 */
export function reactionPolarity(
  glyph: string | null | undefined,
): "positive" | "negative" | "neutral" {
  if (glyph === "👎") return "negative";
  if (glyph === "❤️" || glyph === "👍" || glyph === "😂" || glyph === "‼️") return "positive";
  return "neutral"; // ❓, custom "reacted", unknown
}

export function decayMultiplier(recentFires: FireRecord[]): number {
  // Vetoed and errored fires never reached the user — they carry no
  // engagement information and must not occupy window slots (a run of
  // vetoes would otherwise dilute the last real outcomes out of view).
  const window = recentFires
    .filter((f) => f.outcome !== "vetoed" && f.outcome !== "error")
    .slice(0, 5);
  const negative = window.filter(
    (f) =>
      f.outcome === "ignored" ||
      f.outcome === "pushed_back" ||
      (f.outcome === "reacted" && reactionPolarity(f.reactionGlyph) === "negative"),
  ).length;
  if (negative === 0) {
    const positive = window.filter(
      (f) =>
        f.outcome === "engaged" ||
        (f.outcome === "reacted" && reactionPolarity(f.reactionGlyph) === "positive"),
    ).length;
    return positive >= 3 ? 0.75 : 1.0;
  }
  if (negative === 1) return 1.5;
  if (negative === 2) return 2.0;
  if (negative === 3) return 3.0;
  return 4.0;
}

/**
 * Per-topic 3-use-per-week cap for user-supplied focus suggestions.
 *
 * Returns the set of topics the ghost is told to AVOID this tick
 * because they've been overused. The ghost prompt should mention
 * the over-used topics so the model knows not to lean on them again.
 *
 * `nowMs` is used to age out expired suggestions.
 */
export function focusSuggestionStatus(
  suggestions: FocusSuggestion[],
  nowMs: number,
): {
  active: FocusSuggestion[];
  overUsed: FocusSuggestion[];
} {
  const WEEK_MS = 7 * 86_400_000;
  const active: FocusSuggestion[] = [];
  const overUsed: FocusSuggestion[] = [];
  for (const s of suggestions) {
    if (s.expiresAtMs !== null && s.expiresAtMs < nowMs) continue;
    // Week-aware on READ so an over-used topic un-sticks once its window
    // rolls even if no new fire has landed to rewrite the row.
    const windowLive = s.weekStartMs !== undefined && nowMs - s.weekStartMs < WEEK_MS;
    const effectiveCount = windowLive ? s.usageCount : 0;
    if (effectiveCount >= 3) {
      overUsed.push(s);
    } else {
      active.push({ ...s, usageCount: effectiveCount });
    }
  }
  return { active, overUsed };
}

/**
 * Convenience: run all the cheap gates and return the first failure or
 * { ok: true }. Used by the ghost think() module before any Haiku call.
 * `globalEnabled` is `config.brown_nose.enabled`.
 */
export function preflightGate(args: {
  prefs: BrownNosePrefs;
  globalEnabled: boolean;
  intensity: number;
  recentFires: FireRecord[];
  weekFires: FireRecord[];
  nowMs: number;
}): GateResult {
  const checks: GateResult[] = [
    checkEnabled(args.prefs, args.globalEnabled),
    checkActiveHours(args.prefs, args.nowMs),
    checkCooldown(args.prefs, args.recentFires, args.intensity, args.nowMs),
    checkWeeklyCap(args.prefs, args.weekFires),
  ];
  for (const c of checks) if (!c.ok) return c;
  return { ok: true };
}

/**
 * The next instant at or after `fromMs` that falls inside one of the
 * session's active-hours windows (in the session's timezone). Returns
 * `fromMs` itself when it's already inside a window; null when the
 * session has no windows at all.
 *
 * Used to clamp proactive fire times INTO the window instead of letting
 * the fire-time gate drop them — the failure that killed the first-ever
 * organic brown-nose fire (ghost picked "tomorrow 8am", window opened
 * at 9, fire dropped).
 */
export function nextActiveStartMs(
  prefs: Pick<BrownNosePrefs, "activeHours" | "timezone">,
  fromMs: number,
): number | null {
  if (prefs.activeHours.length === 0) return null;
  if (checkActiveHours(prefs as BrownNosePrefs, fromMs).ok) return fromMs;

  const local = localDayAndMinutes(fromMs, prefs.timezone);
  const dowIdx: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const todayIdx = dowIdx[local.dow] ?? 1;
  let bestMinutes: number | null = null;
  for (const w of prefs.activeHours) {
    const wIdx = dowIdx[w.dow];
    if (wIdx === undefined) continue;
    const start = parseHHMM(w.start);
    if (start === null) continue;
    let daysOut = (wIdx - todayIdx + 7) % 7;
    // Same-day window that already started (we know we're outside it, so
    // it must have ended) rolls to next week.
    if (daysOut === 0 && start <= local.minutes) daysOut = 7;
    const totalMinutes = daysOut * 24 * 60 + (start - local.minutes);
    if (bestMinutes === null || totalMinutes < bestMinutes) bestMinutes = totalMinutes;
  }
  return bestMinutes === null ? null : fromMs + bestMinutes * 60_000;
}

// ---- internal helpers ----

const DOW_INDEX: Record<number, ActiveHoursWindow["dow"]> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

/**
 * Resolve (unixMs, timezone) → (dow, minutes-since-midnight) in that
 * timezone. Uses Intl.DateTimeFormat — built-in, accurate for DST,
 * no third-party dep needed.
 */
function localDayAndMinutes(
  ms: number,
  timezone: string,
): { dow: ActiveHoursWindow["dow"]; minutes: number } {
  // Compose a single formatter with everything we need.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  let dow: ActiveHoursWindow["dow"] = "mon";
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "weekday") {
      dow = (p.value.toLowerCase() as ActiveHoursWindow["dow"]) || "mon";
    } else if (p.type === "hour") {
      // Intl can return "24" for midnight on some platforms; normalize.
      const h = Number.parseInt(p.value, 10);
      hour = Number.isFinite(h) ? h % 24 : 0;
    } else if (p.type === "minute") {
      minute = Number.parseInt(p.value, 10);
    }
  }
  // Hardening: if "weekday" came back as something we don't recognize,
  // fall back to UTC day-of-week on the original date. (Defensive — the
  // Intl spec guarantees one of the seven short names for en-US.)
  if (!["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(dow)) {
    dow = DOW_INDEX[new Date(ms).getUTCDay()] ?? "mon";
  }
  return { dow, minutes: hour * 60 + minute };
}

function parseHHMM(s: string): number | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number.parseInt(m[1]!, 10);
  const min = Number.parseInt(m[2]!, 10);
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}

function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
