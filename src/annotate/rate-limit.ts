/**
 * Sliding-window, in-memory rate limiter for the annotation routes.
 *
 * Caps how often a given remote IP can hit the endpoint, so an attacker
 * can't spray guesses at /a/<id>/<key>. Memory-only is fine here:
 *   - The dashboard is a single process (no fan-out).
 *   - State loss on restart is acceptable — it just resets counters.
 *
 * Not meant to be a general-purpose limiter; keep the surface small.
 */

export type LimiterOptions = {
  /** How many hits allowed per window. */
  max: number;
  /** Window size in ms. */
  windowMs: number;
  /** Upper bound on distinct keys kept in memory (prevents DOS via ip churn). */
  maxKeys?: number;
};

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(opts: LimiterOptions) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  /**
   * Record a hit for `key` and return whether the caller is still under the
   * limit. The check and record happen atomically — never call this twice
   * "to check then record", that would double-count.
   */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let arr = this.hits.get(key);
    if (!arr) {
      if (this.hits.size >= this.maxKeys) this.evictOne();
      arr = [];
      this.hits.set(key, arr);
    }
    // Drop timestamps that fell out of the window. Amortized O(1) because
    // each timestamp is pushed once and dropped once.
    let i = 0;
    while (i < arr.length && arr[i]! < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    if (arr.length >= this.max) return false;
    arr.push(now);
    return true;
  }

  /** Drop the oldest-activity key. Cheap DOS protection — not precise LRU. */
  private evictOne(): void {
    const first = this.hits.keys().next();
    if (!first.done) this.hits.delete(first.value);
  }
}
