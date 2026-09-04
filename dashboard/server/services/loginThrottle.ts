/**
 * Per-client throttle for PIN login attempts.
 *
 * A PIN is short by design, so the login route has to make guessing slow.
 * Five failures in a minute lock the client out for a minute; each further
 * lockout doubles, up to fifteen minutes. A success clears the record. In
 * memory only: the dashboard is one process and losing counters on restart
 * is fine.
 */

export type ThrottleVerdict = { allowed: true } | { allowed: false; retryAfterSec: number };

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private readonly lockedUntil = new Map<string, number>();
  private readonly lockouts = new Map<string, number>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 60_000,
    private readonly baseLockMs = 60_000,
    private readonly maxLockMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): ThrottleVerdict {
    const until = this.lockedUntil.get(key);
    if (until !== undefined) {
      const t = this.now();
      if (t < until)
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((until - t) / 1000)) };
      this.lockedUntil.delete(key);
    }
    return { allowed: true };
  }

  recordFailure(key: string): ThrottleVerdict {
    const t = this.now();
    const arr = (this.failures.get(key) ?? []).filter((ts) => ts > t - this.windowMs);
    arr.push(t);
    this.failures.set(key, arr);
    if (arr.length < this.maxFailures) return { allowed: true };
    const n = (this.lockouts.get(key) ?? 0) + 1;
    this.lockouts.set(key, n);
    const lockMs = Math.min(this.maxLockMs, this.baseLockMs * 2 ** (n - 1));
    this.lockedUntil.set(key, t + lockMs);
    this.failures.delete(key);
    return { allowed: false, retryAfterSec: Math.ceil(lockMs / 1000) };
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
    this.lockedUntil.delete(key);
    this.lockouts.delete(key);
  }
}
