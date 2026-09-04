import { sendMessage } from "../imessage/send.ts";
import type { AlertStore } from "./store.ts";

/**
 * Deliver error alerts directly to the operator via iMessage, bypassing
 * Claude entirely. Used when the thing breaking IS Claude (auth expired,
 * persistent runner failures, quota exhaustion) — a normal outbound would
 * just error again.
 *
 * Rate-limited in-memory by error signature: if auth is dead, we'd
 * otherwise spam the operator every 30s as inbound messages pile up. One
 * alert per signature per configured window is plenty to raise awareness
 * without drowning them.
 *
 * Signature = category prefix (e.g. "claude-inbound", "cron-fire") + first
 * ~120 chars of the error. Different error shapes alert independently,
 * same error stays quiet.
 */
/** Hard cap on the dedup map. A pathological error generator (stack
 *  traces with embedded timestamps, varying memory addresses) could
 *  otherwise grow this without bound over weeks of uptime. */
const MAX_SIGNATURES = 1000;

export class OperatorAlert {
  private lastSentAt = new Map<string, number>();
  private handle: string;
  private minIntervalMs: number;
  private store: AlertStore | null;

  constructor(params: {
    operatorHandle: string;
    minIntervalMinutes: number;
    store?: AlertStore | null;
  }) {
    this.handle = params.operatorHandle.trim();
    this.minIntervalMs = params.minIntervalMinutes * 60_000;
    this.store = params.store ?? null;
  }

  enabled(): boolean {
    return this.handle.length > 0;
  }

  /**
   * Send an alert if we haven't already sent this signature recently.
   * Returns true if we actually sent one.
   */
  async notify(params: {
    category: string;
    error: string;
    context?: Record<string, string | number>;
  }): Promise<boolean> {
    if (!this.enabled()) return false;
    const sig = this.signature(params.category, params.error);
    const now = Date.now();
    const last = this.lastSentAt.get(sig) ?? 0;
    if (now - last < this.minIntervalMs) return false;

    // Persistent per-category mute (set from dashboard). Suppresses
    // delivery but still records the attempt so operators can see what
    // would have fired.
    const muted = this.store?.isMuted(params.category, now) ?? false;

    const body = this.formatBody(params);
    const res = muted
      ? { ok: false as const, error: "muted" }
      : await sendMessage({ to: this.handle, isGroup: false, text: body });
    if (this.store) {
      this.store.record({
        category: params.category,
        signature: sig,
        text: body,
        context: params.context ? JSON.stringify(params.context) : null,
        delivered: res.ok,
      });
    }
    if (res.ok) {
      // Map insertion order = age; if we're at the cap, drop the
      // oldest entry before inserting. Cheap LRU-by-insertion since
      // we never update an existing key without also having sent.
      if (this.lastSentAt.size >= MAX_SIGNATURES) {
        const oldest = this.lastSentAt.keys().next().value;
        if (oldest !== undefined) this.lastSentAt.delete(oldest);
      }
      this.lastSentAt.set(sig, now);
      console.log(`[alert] sent to ${this.handle} category=${params.category}`);
      return true;
    }
    // If the alert itself failed to send (Messages.app down, imsg broken),
    // logging is all we've got — don't recurse into another alert attempt.
    console.error(`[alert] failed to deliver: ${res.error}`);
    return false;
  }

  private signature(category: string, error: string): string {
    return `${category}::${error.trim().slice(0, 120)}`;
  }

  private formatBody(params: {
    category: string;
    error: string;
    context?: Record<string, string | number>;
  }): string {
    const lines = [`⚠️ edmund-harness: ${params.category}`];
    if (params.context) {
      for (const [k, v] of Object.entries(params.context)) lines.push(`${k}: ${v}`);
    }
    // Keep errors short enough to fit in one iMessage bubble; full detail is
    // in daemon.log if the operator needs it.
    const err = params.error.replace(/\s+/g, " ").trim();
    lines.push("", err.length > 400 ? `${err.slice(0, 400)}…` : err);
    lines.push("", "(auto-alert, daemon.log has full detail)");
    return lines.join("\n");
  }
}

/**
 * Classify a runner error to decide if it's operator-actionable.
 * Auth failures, persistent quota issues, and process-spawn failures need
 * human attention; per-turn timeouts on a single YouTube summary don't.
 */
export function isOperatorActionable(error: string): boolean {
  const e = error.toLowerCase();
  return (
    e.includes("401") ||
    e.includes("403") ||
    e.includes("authentication") ||
    e.includes("unauthorized") ||
    e.includes("forbidden") ||
    e.includes("invalid authentication") ||
    e.includes("quota") ||
    e.includes("billing") ||
    e.includes("exceeded your") ||
    // Claude Code subscription/limit strings — observed verbatim in
    // production; none contain "quota"/"exceeded your", so they were
    // silent before these rows.
    e.includes("session limit") ||
    e.includes("out of extra usage") ||
    e.includes("subscription access") ||
    e.includes("enoent") || // missing binary / path
    e.includes("executable not found") ||
    e.includes("eacces") ||
    e.includes("not allowed")
  );
}

/**
 * Broader classifier: should we retry this error?
 *
 * Superset of isOperatorActionable — auth/quota/binary errors get retried
 * (they clear themselves once the user fixes things, and a retry is how
 * that recovery lands a reply to the user). Also covers timeouts and
 * transient network/process errors, which frequently succeed on a second
 * attempt.
 *
 * Non-retryable: validation errors, prompt-too-long, model-specific
 * rejections — no amount of retrying fixes those.
 */
export function isRetryable(error: string): boolean {
  if (isOperatorActionable(error)) return true;
  const e = error.toLowerCase();
  return (
    e.includes("timeout") ||
    e.includes("timed out") ||
    e.includes("econnreset") ||
    e.includes("econnrefused") ||
    e.includes("etimedout") ||
    e.includes("socket hang up") ||
    e.includes("network error") ||
    e.includes("fetch failed") ||
    e.includes("claude exited without result") ||
    /claude exit [1-9]/.test(e) ||
    // A turn is mid-flight on this session's worker — inherently transient.
    // Without this, a bg-job-done wake-up that collides with a running turn
    // is dropped forever (four generated-image notices were lost this way
    // when a lock timeout let cron fires race a still-running turn).
    e.includes("worker busy") ||
    e.includes("overloaded") ||
    e.includes("503") ||
    e.includes("502") ||
    e.includes("504") ||
    e.includes("529")
  );
}
