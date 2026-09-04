/**
 * In-memory concurrency guard for brown-nose fires.
 *
 * Two responsibilities:
 *
 *   1. **Concurrency cap.** At most `maxConcurrent` fires may be
 *      in-flight at the same time across all sessions. Callers
 *      `tryAcquire()`; if the cap is full, they get back a
 *      `{ acquired: false }` and reschedule via cron deferral.
 *
 *   2. **Stagger floor.** Even when below the cap, callers can't fire
 *      within `minSpacingMs` of the most-recently-completed fire. This
 *      forces a minimum global cadence so brown-nose moves don't
 *      cluster into a noisy burst.
 *
 * Survival across daemon restart is not a concern. If the daemon dies
 * mid-fire, the in-flight slot is implicitly released; the cron row's
 * retry behavior (existing in cron/fire.ts) handles redelivery.
 *
 * The module-level `defaultSemaphore` is set up once at daemon boot by
 * `initSemaphore({ maxConcurrent, minSpacingMs })`. Callers anywhere
 * (cron fire handler, tests, CLI) reach for it via `getSemaphore()`.
 */

export type AcquireResult =
  | { acquired: true; release: () => void }
  | { acquired: false; reason: "cap_full" | "stagger" };

export class ProactiveSemaphore {
  private inFlight = 0;
  private lastReleaseAtMs = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly minSpacingMs: number,
  ) {}

  tryAcquire(nowMs: number = Date.now()): AcquireResult {
    if (this.inFlight >= this.maxConcurrent) {
      return { acquired: false, reason: "cap_full" };
    }
    if (this.lastReleaseAtMs > 0 && nowMs - this.lastReleaseAtMs < this.minSpacingMs) {
      return { acquired: false, reason: "stagger" };
    }
    this.inFlight++;
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return; // idempotent
        released = true;
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.lastReleaseAtMs = Date.now();
      },
    };
  }

  /** Snapshot for telemetry / CLI status. */
  snapshot(): { inFlight: number; cap: number; lastReleaseAtMs: number; minSpacingMs: number } {
    return {
      inFlight: this.inFlight,
      cap: this.maxConcurrent,
      lastReleaseAtMs: this.lastReleaseAtMs,
      minSpacingMs: this.minSpacingMs,
    };
  }
}

let defaultSemaphore: ProactiveSemaphore | null = null;

export function initSemaphore(opts: { maxConcurrent: number; minSpacingMs: number }): void {
  defaultSemaphore = new ProactiveSemaphore(opts.maxConcurrent, opts.minSpacingMs);
}

/** Returns the daemon-level semaphore. Throws if not initialized — the
 *  daemon boots `initSemaphore` before anything tries to fire. */
export function getSemaphore(): ProactiveSemaphore {
  if (!defaultSemaphore) {
    throw new Error("proactive semaphore not initialized — call initSemaphore() first");
  }
  return defaultSemaphore;
}
