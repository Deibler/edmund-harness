import type { CronStore } from "../cron/store.ts";
import type { BgJobStore } from "./store.ts";

/**
 * Daemon-level reaper for background tool jobs. Catches runners that
 * crashed or never started, so the parent session never sits waiting on a
 * wake-up that will never come.
 *
 * Fires a "failed" cron wake-up for each reaped job so the model is
 * re-invoked and can apologize / retry.
 */
export function reapStuckBgJobs(
  store: BgJobStore,
  crons: CronStore,
  opts: {
    pendingStaleMs: number;
    runningStaleMs: number;
    /** Lower bound on missing-wake recovery age — give the normal path
     *  time to stamp before recovering. Default 60s. */
    missingWakeMinAgeMs?: number;
    /** Upper bound — never recover wakes for jobs that finished more
     *  than this long ago. Default 1h. The user has moved on; a wake
     *  message arriving hours later is spam. */
    missingWakeMaxAgeMs?: number;
  },
): void {
  // 1. Jobs stuck in pending/running — runner never started or crashed mid-flight.
  const stuck = store.listStuck(opts);
  for (const j of stuck) {
    try {
      const age = Math.round((Date.now() - j.createdAt) / 1000);
      const reason = `reaped by daemon (stuck in ${j.status} for ${age}s)`;
      store.finish(j.id, "failed", null, null, reason);
      console.warn(`[bg-jobs] reaper: ${j.id} ${j.toolName} → failed (${reason})`);

      const body = [
        `Background tool job FAILED (status: failed).`,
        ``,
        `Job id: ${j.id}`,
        `Tool: ${j.toolName}`,
        `Error: ${reason}`,
        ``,
        `The user is waiting. Apologize briefly and suggest a retry or alternative approach.`,
      ].join("\n");
      crons.create({
        sessionKey: j.sessionKey,
        systemEvent: body,
        schedule: { kind: "once", atMs: Date.now() + 2000 },
      });
      crons.cancelPokes(j.sessionKey);
      store.markWakeFired(j.id);
    } catch (err) {
      console.error(`[bg-jobs] reaper: failed to handle ${j.id}: ${String(err).slice(0, 200)}`);
    }
  }

  // 2. Jobs that finished but never woke their session — runner crashed
  // between finish() and crons.create(). Bounded on BOTH sides:
  // - min age (default 60s): give the normal wake-up path time to settle.
  // - max age (default 1h):  beyond that the user has moved on; a late
  //   "your image is ready" message is just noise (and a missed-backfill
  //   migration could otherwise re-fire hundreds of historical rows,
  //   which is exactly the 2026-05-18 spam cascade).
  const missingWake = store.listFinishedMissingWake({
    minAgeMs: opts.missingWakeMinAgeMs ?? 60_000,
    maxAgeMs: opts.missingWakeMaxAgeMs ?? 60 * 60 * 1000,
  });
  for (const j of missingWake) {
    try {
      const isDone = j.status === "done";
      const summary = isDone
        ? j.resultSummary || "(no summary available — runner crashed before recording one)"
        : j.errorText || "(no error recorded — runner crashed before stamping one)";
      const header = isDone
        ? `Background tool job finished (status: done) — recovered by reaper after crash.`
        : `Background tool job FAILED (status: failed) — recovered by reaper after crash.`;
      const body = [
        header,
        ``,
        `Job id: ${j.id}`,
        `Tool: ${j.toolName}`,
        ``,
        summary,
        ``,
        isDone
          ? `The user is waiting. Deliver any saved output if appropriate, otherwise relay the result.`
          : `The user is waiting. Apologize briefly and suggest a retry.`,
      ].join("\n");
      crons.create({
        sessionKey: j.sessionKey,
        systemEvent: body,
        schedule: { kind: "once", atMs: Date.now() + 2000 },
      });
      crons.cancelPokes(j.sessionKey);
      store.markWakeFired(j.id);
      console.warn(
        `[bg-jobs] reaper: ${j.id} ${j.toolName} finished without wake — recovery cron fired`,
      );
    } catch (err) {
      console.error(
        `[bg-jobs] reaper: failed to recover missed wake ${j.id}: ${String(err).slice(0, 200)}`,
      );
    }
  }
}
