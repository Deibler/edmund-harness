import { log } from "../util/log.ts";

/**
 * Per-session async mutex. Two callers asking for the same key run
 * sequentially — second one awaits the first. Different keys never block
 * each other.
 *
 * Why: both inbound batches and cron fires eventually call `claude -p
 * --resume <session-id>`. Two concurrent --resume on the same session UUID
 * race inside Claude Code and can corrupt the session store (or just fail
 * one of them). The pipeline already serializes inbound per-session via an
 * internal flag, but cron fires bypass it. This lock is the single point
 * both paths share so nothing slips through.
 *
 * Timeout — a LIVENESS lease, not a wall-clock cap. Every locked section
 * has an inactivity ceiling: if `timeoutMs` passes with no sign of life,
 * we (1) reject the caller's await, (2) IMMEDIATELY release the chain so
 * subsequent inbound for this session isn't held hostage by a stuck turn,
 * and (3) fire the optional onTimeout callback (used for operator alerts).
 * The underlying fn() keeps running — we can't kill it from here — but the
 * lock no longer wedges the session.
 *
 * "Sign of life" is `touch(key)`: the Claude worker heartbeats it on every
 * stdout stream event (see WorkerTurn.onHeartbeat), so a turn that is
 * actively thinking / calling tools holds its lock for as long as the work
 * genuinely takes — a 40-minute video edit is legitimate, not stuck. A
 * holder that never touches (pure I/O sections, tests) degrades to the old
 * behavior: `timeoutMs` from acquisition, wall-clock.
 *
 * Releasing early while fn() is demonstrably alive was the worst outcome of
 * the wall-clock design: the released chain let a second Claude run start on
 * the same session — the very race this lock exists to prevent — and paged
 * the operator about healthy work.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60_000; // 10 min

/** Re-arming the expiry timer on every stream delta would be churn for no
 *  precision gain at a ~11-minute ceiling; coalesce touches to 1/s. */
const TOUCH_THROTTLE_MS = 1_000;

/**
 * Size the per-session lock's inactivity ceiling to sit just above the
 * Claude subprocess's own per-turn idle timeout (`claude.timeout_seconds`).
 *
 * Layering: the worker's idle timer is the primary terminator — it fires
 * after `1×` of stream silence and actually tears the subprocess down,
 * settling the locked section normally. The lock's ceiling at `1× + 60s`
 * is the backstop for hangs OUTSIDE a worker turn (attachment copy,
 * transcription, delivery) — code that emits no heartbeats and is itself
 * bounded well under the ceiling. So an expiry here now means something is
 * genuinely wedged, not merely slow: heartbeats extend the lease for any
 * amount of healthy streaming work.
 */
export function sessionLockTimeoutMs(claudeTurnTimeoutMs: number): number {
  return claudeTurnTimeoutMs + 60_000;
}

export type SessionLocksOptions = {
  /** Inactivity ceiling per lock hold — max ms without a touch() before the
   *  chain is released. Defaults to 10 min. */
  defaultTimeoutMs?: number;
  /** Called when a lock holder goes silent past its ceiling — typically
   *  wired to the operator alert channel. Receives the key, total ms the
   *  holder ran, and the inactivity ceiling it breached. */
  onTimeout?: (key: string, elapsedMs: number, timeoutMs?: number) => void;
};

/** Live holder registry entry — lets touch(key) reach the active hold's
 *  re-arm closure without threading a lease object through every caller. */
type ActiveHold = { extend: () => void };

export class SessionLocks {
  private tails = new Map<string, Promise<void>>();
  /** Key → the CURRENTLY RUNNING holder's lease. At most one per key (the
   *  chain serializes holds). Removed at settle/expiry so late touches from
   *  a released holder can't extend a successor's lease — near-impossible
   *  anyway, since a silent worker is torn down by its own idle timeout
   *  before the lock ceiling fires. */
  private active = new Map<string, ActiveHold>();
  private readonly defaultTimeoutMs: number;
  private readonly onTimeout?: (key: string, elapsedMs: number, timeoutMs?: number) => void;

  constructor(opts: SessionLocksOptions = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.onTimeout = opts.onTimeout;
  }

  /**
   * Liveness heartbeat from the current holder's work — re-arms its expiry
   * timer. Safe to call at any frequency (throttled internally) and from
   * anywhere that knows the session key; a no-op when no hold is active.
   */
  touch(key: string): void {
    this.active.get(key)?.extend();
  }

  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const curr = new Promise<void>((r) => {
      release = r;
    });
    this.tails.set(key, curr);
    let hold: ActiveHold | null = null;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    try {
      await prev;
      const startedAt = Date.now();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout>;
      let lastArmAt = startedAt;
      let extendedPastCeiling = false;
      const work = fn();
      const guarded = new Promise<T>((resolve, reject) => {
        const expire = () => {
          timedOut = true;
          this.clearActive(key, hold);
          const elapsed = Date.now() - startedAt;
          log.error(
            "session-lock",
            "no liveness signal — releasing lock; fn() continues in background",
            {
              session: key,
              heldMs: elapsed,
              silentMs: Date.now() - lastArmAt,
              timeoutMs,
            },
          );
          try {
            this.onTimeout?.(key, elapsed, timeoutMs);
          } catch (err) {
            log.warn("session-lock", "onTimeout threw", {
              err: (err as Error).message,
              session: key,
            });
          }
          reject(
            new Error(
              `session lock timeout: no liveness for ${timeoutMs}ms (key=${key}, held ${elapsed}ms)`,
            ),
          );
        };
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(expire, timeoutMs);
          timer.unref?.();
        };
        hold = {
          extend: () => {
            if (timedOut) return;
            const now = Date.now();
            if (now - lastArmAt < TOUCH_THROTTLE_MS) return;
            lastArmAt = now;
            // One log line per hold the first time a lease outlives the old
            // wall-clock cap — the operator sees "long turn, still alive"
            // in the daemon log instead of a phone alert.
            if (!extendedPastCeiling && now - startedAt > timeoutMs) {
              extendedPastCeiling = true;
              log.info("session-lock", "holder alive past ceiling — lease extended", {
                session: key,
                heldMs: now - startedAt,
                timeoutMs,
              });
            }
            arm();
          },
        };
        this.active.set(key, hold);
        arm();
        work.then(
          (v) => {
            clearTimeout(timer);
            if (!timedOut) resolve(v);
            // The ceiling already fired and we rejected the caller — but fn()
            // finished cleanly, so it was silent, not dead. Say so, so the
            // earlier ERROR/alert isn't mistaken for an unresolved failure.
            else
              log.info("session-lock", "silent holder finished OK after lock release — not stuck", {
                session: key,
                elapsedMs: Date.now() - startedAt,
              });
          },
          (e) => {
            clearTimeout(timer);
            if (!timedOut) reject(e);
            else
              log.warn("session-lock", "fn() rejected after timeout", {
                session: key,
                err: String(e).slice(0, 200),
              });
          },
        );
      });
      return await guarded;
    } finally {
      this.clearActive(key, hold);
      release();
      // Clean up only if no one chained after us (prevents unbounded growth
      // on long-lived sessions while still letting chains form normally).
      if (this.tails.get(key) === curr) this.tails.delete(key);
    }
  }

  /** Remove `hold` from the active registry iff it is still the registered
   *  holder — a successor may have installed its own lease already. */
  private clearActive(key: string, hold: ActiveHold | null): void {
    if (hold && this.active.get(key) === hold) this.active.delete(key);
  }
}
