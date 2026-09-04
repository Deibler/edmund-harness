/**
 * Tracks consecutive failures of a periodic task and escalates once a
 * threshold is crossed: fires `onEscalate` exactly once per "outage", and
 * (optionally) tells the caller to skip cycles so a broken task stops
 * hammering whatever it's failing against.
 *
 * Typical use, wrapping a `setInterval` body:
 *
 *   const esc = new FailureEscalator({
 *     name: "recovery-sweep",
 *     threshold: 5,
 *     onEscalate: (n) => alert.notify({ category: "recovery sweep failing", error: `${n} in a row` }),
 *   });
 *   setInterval(async () => {
 *     if (esc.shouldSkip()) return;
 *     try { await doWork(); esc.recordSuccess(); }
 *     catch (err) { esc.recordFailure(err); }
 *   }, intervalMs);
 *
 * Stateless across restarts (in-memory) — a fresh process starts clean,
 * which is the right behavior for "is this currently broken?".
 */
export class FailureEscalator {
  private consecutive = 0;
  private escalated = false;
  /** Round-robin counter used to thin out cycles after escalation. */
  private skipPhase = 0;

  private name: string;
  private threshold: number;
  private backoffFactor: number;
  private onEscalate: (count: number, lastError: unknown) => void | Promise<void>;
  private onRecover?: (afterCount: number) => void;

  constructor(opts: {
    name: string;
    /** Fire `onEscalate` after this many consecutive failures. */
    threshold: number;
    /** After escalation, run only 1 of every `backoffFactor` cycles. Default 4. 1 = no backoff. */
    backoffFactor?: number;
    onEscalate: (count: number, lastError: unknown) => void | Promise<void>;
    onRecover?: (afterCount: number) => void;
  }) {
    this.name = opts.name;
    this.threshold = Math.max(1, opts.threshold);
    this.backoffFactor = Math.max(1, opts.backoffFactor ?? 4);
    this.onEscalate = opts.onEscalate;
    this.onRecover = opts.onRecover;
  }

  /** True if the caller should skip this cycle (post-escalation backoff). */
  shouldSkip(): boolean {
    if (!this.escalated || this.backoffFactor === 1) return false;
    this.skipPhase = (this.skipPhase + 1) % this.backoffFactor;
    return this.skipPhase !== 0;
  }

  recordSuccess(): void {
    if (this.consecutive > 0 || this.escalated) {
      const after = this.consecutive;
      if (this.escalated) this.onRecover?.(after);
      this.consecutive = 0;
      this.escalated = false;
      this.skipPhase = 0;
    }
  }

  recordFailure(err: unknown): void {
    this.consecutive++;
    console.error(
      `[${this.name}] failure #${this.consecutive}:`,
      err instanceof Error ? err.message : String(err),
    );
    if (!this.escalated && this.consecutive >= this.threshold) {
      this.escalated = true;
      void this.onEscalate(this.consecutive, err);
    }
  }

  /** Current consecutive-failure count (for tests / diagnostics). */
  get failureCount(): number {
    return this.consecutive;
  }

  /** Whether we're currently in the escalated/backing-off state. */
  get isEscalated(): boolean {
    return this.escalated;
  }
}
