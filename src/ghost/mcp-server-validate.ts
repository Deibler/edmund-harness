/**
 * Fire-time validation for the ghost's submit_decision tool — split out of
 * mcp-server.ts so tests can import it without starting the stdio server.
 *
 * A bad time comes back to the model as a tool ERROR it must fix and
 * retry, instead of the harness silently moving (or dropping) the fire:
 *   - fire_at_ms in the past         → the wrong-year arithmetic bug
 *   - fire_at_ms > 14 days out       → same bug, other direction
 *   - expiry not after fire          → dead-on-arrival brief
 *   - fire outside the chat's allowed hours → names the next window opening
 */

import { nextActiveStartMs } from "./budget.ts";

export type TimeGuard = {
  activeHours: Array<{ dow: string; start: string; end: string }>;
  timezone: string;
} | null;

const MAX_FIRE_DELAY_MS = 14 * 24 * 3_600_000;

/** Returns an error string for the model to retry on, or null when the
 *  scheduling fields are acceptable. */
export function validateFireTime(
  fireAtMs: number | undefined,
  expiresAtMs: number | undefined,
  nowMs: number,
  guard: TimeGuard,
): string | null {
  if (fireAtMs === undefined) return null; // "now" is always valid
  if (fireAtMs < nowMs - 60_000) {
    return `fire_at_ms=${fireAtMs} is IN THE PAST (now=${nowMs}). You must compute it as now + offset using the TIME_CONTEXT epoch anchors — never derive an absolute epoch from a calendar date. Retry with a corrected fire_at_ms.`;
  }
  if (fireAtMs > nowMs + MAX_FIRE_DELAY_MS) {
    return `fire_at_ms=${fireAtMs} is more than 14 days out (now=${nowMs}) — almost certainly a date-arithmetic error. Compute as now + offset and retry; if the hook genuinely lands weeks away, submit act:false with a snooze instead and let a future tick re-find it.`;
  }
  if (expiresAtMs !== undefined && expiresAtMs <= fireAtMs) {
    return `expires_at_ms=${expiresAtMs} is not after fire_at_ms=${fireAtMs} — the fire would be dead on arrival. Retry with expires_at_ms comfortably after the fire time (or omit it for fire+24h).`;
  }
  if (guard && guard.activeHours.length > 0) {
    const prefs = {
      activeHours: guard.activeHours as never,
      timezone: guard.timezone,
    };
    const opening = nextActiveStartMs(prefs, fireAtMs);
    if (opening !== null && opening !== fireAtMs) {
      return `fire_at_ms=${fireAtMs} falls OUTSIDE this chat's allowed hours (${guard.timezone}: ${guard.activeHours.map((w) => `${w.dow} ${w.start}-${w.end}`).join(", ")}). The next window opens at epoch-ms ${opening}. Retry with a fire_at_ms inside a window — e.g. the opening value plus however far into the window you want it.`;
    }
  }
  return null;
}
