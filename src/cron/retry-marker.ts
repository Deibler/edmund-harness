import { log } from "../util/log.ts";
import type { CronStore } from "./store.ts";

/**
 * Inbound-retry crons are the one-shot rows `scheduleInboundRetry`
 * (channels/turn.ts) queues after a failed inbound turn. They share the
 * generic `[Retry n/m]` prefix with scheduled-event retries (daily briefs
 * etc.), so detection keys on the distinctive body line too — we must never
 * cancel a legitimate scheduled-event retry just because a chat turn
 * succeeded.
 */
const INBOUND_RETRY_BODY = "A prior turn from";

const INBOUND_RETRY_RE = /^\[Retry \d+\/\d+\] A prior turn from /;

export function isInboundRetryEvent(systemEvent: string): boolean {
  return INBOUND_RETRY_RE.test(systemEvent);
}

/**
 * Should this inbound-retry fire be skipped because the burst it was queued
 * for has since been answered?
 *
 * Two conditions, both required:
 *  - the session's last outbound postdates its last inbound (the classic
 *    "burst answered" check), AND
 *  - that outbound landed AFTER this retry was queued.
 *
 * The second condition matters because mid-turn tool sends (send_message /
 * send_attachment) bump last_outbound_ms at send time. A heads-up sent
 * BEFORE the turn failed ("on it, gimme a sec" → crash) must not count as
 * the answer — the retry is the model's chance to resume and decide for
 * itself whether the user still needs anything; the retry envelope already
 * tells it "if you completed via tool calls, just finish naturally". Only
 * an outbound that landed after the failure proves a later turn (recovery,
 * fresh inbound, outbox flush) actually handled the burst.
 */
export function inboundRetryAlreadyAnswered(
  job: { systemEvent: string; createdAt: number },
  session: { lastInboundMs: number; lastOutboundMs: number },
): boolean {
  if (!isInboundRetryEvent(job.systemEvent)) return false;
  return session.lastOutboundMs >= session.lastInboundMs && session.lastOutboundMs >= job.createdAt;
}

/**
 * Cancel every active inbound-retry cron for a session. Called after a turn
 * DELIVERS to the user (normal path or recovery path): the burst the retry
 * was queued for has been answered, so letting it fire would re-invoke the
 * model on a stale failure and produce a second, out-of-context reply —
 * the "stale loop" pattern. Returns the number cancelled.
 */
export function cancelInboundRetries(crons: CronStore, sessionKey: string): number {
  let n = 0;
  try {
    for (const job of crons.listActive(sessionKey)) {
      if (!isInboundRetryEvent(job.systemEvent)) continue;
      try {
        if (crons.cancel(job.id)) n++;
      } catch {}
    }
  } catch (err) {
    log.warn("cron", "inbound-retry cancel failed", {
      session: sessionKey,
      err: String(err).slice(0, 120),
    });
  }
  if (n > 0) {
    log.info("cron", "cancelled stale inbound retries", { session: sessionKey, count: n });
  }
  return n;
}
