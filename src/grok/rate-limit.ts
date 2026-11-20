/**
 * Sliding-window counter, keyed. In memory: a restart forgives everyone, which
 * is the right trade for a limiter whose job is to stop a runaway client, not
 * to keep a ledger.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one hit for `key`. False when it is over the limit (and not counted). */
  take(key: string): boolean {
    const t = this.now();
    const recent = this.recent(key, t);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** True while `key` is at its limit, without counting a hit. */
  blocked(key: string): boolean {
    return this.recent(key, this.now()).length >= this.limit;
  }

  private recent(key: string, t: number): number[] {
    const cutoff = t - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) this.hits.delete(key);
    return kept;
  }
}
