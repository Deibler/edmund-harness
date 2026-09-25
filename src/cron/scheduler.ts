import { humanMs, log } from "../util/log.ts";
import type { CronStore } from "./store.ts";
import type { CronJob } from "./types.ts";

export type SchedulerOptions = {
  store: Pick<CronStore, "nextDue" | "markFired">;
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
 *
 * Fires for one session run one after another, in due order; different
 * sessions do not wait for each other. They used to: the drain awaited each
 * fire, a whole model turn, so on 2026-09-25 one 38-minute bg-job-done turn
 * in a DM held the mirror's 21:00 severe-weather check until it was 34
 * minutes late and skipped as stale.
 */
export class Scheduler {
  private store: SchedulerOptions["store"];
  private onFire: SchedulerOptions["onFire"];
  private onError: SchedulerOptions["onError"];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedForMs: number | null = null;
  private stopped = false;
  /**
   * True while `fireDue` drains. Guards a nasty race: a `poke()` (the 15s
   * heartbeat from main.ts) landing mid-drain would see `armedForMs===null`,
   * pull a still-unmarked job out of `nextDue()`, and fire the SAME job
   * twice — the user sees duplicate replies. The drain marks each job fired
   * before handing it on and never awaits a fire, so it is short now, but
   * the flag still keeps a second drain out.
   */
  private firing = false;
  /** Each session's chain of fires, while any is queued or running. */
  private chains = new Map<string, Promise<void>>();

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
        this.launch(job);
      }
    } finally {
      this.firing = false;
      this.rearm();
    }
  }

  /** Queue a fire behind its own session's earlier fires, never behind
   *  another session's. */
  private launch(job: CronJob): void {
    const prev = this.chains.get(job.sessionKey) ?? Promise.resolve();
    const run = async (): Promise<void> => {
      try {
        await this.onFire(job);
      } catch (err) {
        this.onError?.(err);
      }
    };
    const next = prev.then(run);
    this.chains.set(job.sessionKey, next);
    void next.then(() => {
      if (this.chains.get(job.sessionKey) === next) this.chains.delete(job.sessionKey);
    });
  }
}
