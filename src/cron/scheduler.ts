import { humanMs, log } from "../util/log.ts";
import type { CronStore } from "./store.ts";
import type { CronJob } from "./types.ts";

export type SchedulerOptions = {
  store: CronStore;
  onFire: (job: CronJob) => Promise<void> | void;
  onError?: (err: unknown) => void;
};

/**
 * Fire-and-reschedule loop. Keeps one setTimeout armed for the next-due job.
 * When that job fires, we hand it to `onFire`, then rearm for the new next.
 *
 * Deliberately simple: no threading, no cluster. One process owns all jobs.
 * `poke()` lets callers (e.g. the MCP tool handler that just created a job)
 * re-evaluate the timer without waiting for the previous one to expire.
 */
export class Scheduler {
  private store: CronStore;
  private onFire: SchedulerOptions["onFire"];
  private onError: SchedulerOptions["onError"];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedForMs: number | null = null;
  private stopped = false;
  /**
   * True while `fireDue` is awaiting an `onFire`. Guards against a nasty
   * race: `onFire` can block for a minute+ while Claude generates. If an
   * external `poke()` (the 15s heartbeat from main.ts) lands in that window,
   * the old implementation would see `armedForMs===null`, pull the same
   * still-unmarked job out of `nextDue()`, and arm a second `fireDue` that
   * fires the SAME job concurrently — the user sees duplicate replies.
   * Hold this flag across the whole drain loop; `fireDue` rearms once it
   * finishes.
   */
  private firing = false;

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.onFire = opts.onFire;
    this.onError = opts.onError;
  }

  start(): void {
    this.rearm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Recompute the next wakeup. Call after creating/canceling a job. */
  poke(): void {
    this.rearm();
  }

  private rearm(): void {
    if (this.stopped) return;
    // If a fire is in progress, skip — fireDue rearms itself when it's done.
    // Without this, poke() during a long onFire() double-fires the job.
    if (this.firing) return;
    const next = this.store.nextDue();
    if (!next) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.armedForMs = null;
      log.debug("sched", "idle (no active jobs)");
      return;
    }
    if (this.armedForMs === next.nextFireMs && this.timer) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, next.nextFireMs - Date.now());
    this.armedForMs = next.nextFireMs;
    this.timer = setTimeout(() => void this.fireDue(), Math.min(delay, 2_147_483_000));
    log.debug("sched", "armed", {
      job: next.id,
      session: next.sessionKey,
      at: new Date(next.nextFireMs).toISOString(),
      in: humanMs(delay),
    });
  }

  private async fireDue(): Promise<void> {
    if (this.firing) return;
    this.firing = true;
    this.timer = null;
    this.armedForMs = null;
    try {
      const now = Date.now();
      // Drain all overdue jobs (in case we woke up late).
      while (!this.stopped) {
        const job = this.store.nextDue();
        if (!job || job.nextFireMs > now) break;
        // Mark-before-await: if the daemon crashes mid-onFire (long Claude
        // turn, OOM, etc.) we don't want this recurring job to refire on
        // restart and deliver duplicates. `markFired` advances next_fire_ms
        // (recurring) or sets status=done (one-shot) — either way, after a
        // crash the job is in a safe terminal/advanced state. Loses
        // at-least-once for the in-flight job; gains at-most-once across
        // restarts, which is what the user actually wants.
        this.store.markFired(job, Date.now());
        try {
          await this.onFire(job);
        } catch (err) {
          this.onError?.(err);
        }
      }
    } finally {
      this.firing = false;
      this.rearm();
    }
  }
}
