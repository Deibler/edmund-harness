import type { AgentStore } from "../agents/store.ts";
import type { BgJobStore } from "../background/store.ts";
import { deliverReply } from "../channels/deliver.ts";
import type { Config } from "../config/config.ts";
import type { CronStore } from "../cron/store.ts";
import type { ChatDb } from "../imessage/db.ts";
import type { EchoCache } from "../sessions/echo-cache.ts";
import { type SessionKey, chatIdFromKey } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { log, shortSession } from "../util/log.ts";
import { IMMINENT_CRON_MS, REPLAY_LOOKBACK_MS, ownsRow } from "./sweeper.ts";
import { loadUnansweredInbound } from "./turn.ts";

/**
 * Fallback-notice sweep — the never-go-silent backstop on top of the
 * recovery sweeper.
 *
 * The sweeper's job is to deliver the REAL reply (heal → recovery turn).
 * This sweep's job is narrower: if a burst has sat unanswered past
 * `fallback_notice_after_minutes` despite all of that, tell the user we're
 * still here with one short stopgap note. The unit of obligation is the
 * burst, not the message — `last_fallback_ms >= last_inbound_ms` means the
 * current burst was already acknowledged, and only a NEW inbound re-arms
 * the notice. The note never advances last_outbound_ms, so the sweeper
 * keeps owing (and retrying) the real answer.
 *
 * The notice is meant to be a RARE event — every guard below exists to keep
 * it from firing while the system is still legitimately working:
 *  - boot grace: no notices until the daemon has been up a full deadline,
 *    so a restart with a backlog can't spray notices before catch-up and
 *    the first recovery sweeps have run;
 *  - recovery-first: the burst must have had at least one recovery attempt
 *    (sweeper turn) since it landed — the real-reply machinery always gets
 *    its shot before the stopgap;
 *  - sessions mid-turn (`activeSessions`) — the reply may be seconds away;
 *  - in-flight sub-agents / bg jobs — a long task is running on the user's
 *    behalf; its completion wake-up will answer them;
 *  - an imminent or retry cron — a scheduled fire is about to handle it;
 *  - sessions with a queued outbox — the real reply exists and the send
 *    path is wedged, so a notice would wedge identically (or worse, land
 *    right before the flushed reply);
 *  - bursts whose rows were all replayed/silenced — the model already saw
 *    them and chose silence, which is a valid disposition, not a failure.
 */

export type FallbackDeps = {
  config: Config;
  state: StateStore;
  chatDb: ChatDb;
  echoes: EchoCache;
  activeSessions: Set<SessionKey>;
  agents: AgentStore;
  bgJobs: BgJobStore;
  crons: CronStore;
  /** Wall-clock ms when the recovery loops were wired (post catch-up). */
  bootedAtMs: number;
  /** Test seam; production callers omit it and get the real deliverReply. */
  deliver?: typeof deliverReply;
};

export async function sweepFallbackNotices(
  deps: FallbackDeps,
  now: number = Date.now(),
): Promise<void> {
  const cfg = deps.config.recovery;
  if (!cfg.enabled || !cfg.fallback_notice_enabled) return;
  const deliver = deps.deliver ?? deliverReply;
  const deadlineMs = cfg.fallback_notice_after_minutes * 60_000;

  // Boot grace: a fresh daemon inherits every burst that was owed while it
  // was down. Catch-up + the sweeper get a full deadline to answer them
  // for real before any stopgap text goes out.
  if (now - deps.bootedAtMs < deadlineMs) return;

  for (const session of deps.state.listSessionsNeedingRecovery(now - deadlineMs)) {
    const key = session.sessionKey;
    try {
      if (deps.activeSessions.has(key)) continue;
      if (session.lastFallbackMs >= session.lastInboundMs) continue;
      // The real-reply machinery must have tried at least once for THIS
      // burst. Without this, a notice could beat the first recovery turn.
      if (session.lastRecoveryAttemptMs < session.lastInboundMs) continue;
      if (deps.state.getOutbox(key)) continue;

      // Long work in flight on the user's behalf — its completion wake-up
      // is the reply. Mirrors the sweeper's in-flight checks.
      const agentsInFlight = deps.agents
        .list({ parentSessionKey: key })
        .some((a) => a.status === "pending" || a.status === "running");
      if (agentsInFlight) continue;
      const bgInFlight = deps.bgJobs
        .listForSession(key)
        .some((j) => j.status === "pending" || j.status === "running");
      if (bgInFlight) continue;
      // Any retry/recovery/scheduled fire landing within the next minute
      // gets to answer first.
      const cronImminent = deps.crons
        .listActive(key)
        .some((c) => c.nextFireMs < now + IMMINENT_CRON_MS);
      if (cronImminent) continue;

      // Same "is there real unanswered work" predicate as the sweeper: a
      // session can show lastInbound > lastOutbound forever after the model
      // chose silence on a recovery turn (rows marked replayed). Those owe
      // nothing — a "still on it" note there would be pure noise.
      const sinceMs = Math.max(session.lastOutboundMs, now - REPLAY_LOOKBACK_MS);
      const unanswered = loadUnansweredInbound(deps.chatDb, session.chatGuid, sinceMs).filter(
        (m) => !deps.state.wasReplayed(key, m.rowId) && ownsRow(deps.state, key, m.rowId),
      );
      if (unanswered.length === 0) continue;

      const delivery = await deliver(
        {
          to: session.isGroup === 1 ? session.chatGuid : chatIdFromKey(key),
          isGroup: session.isGroup === 1,
          text: cfg.fallback_notice_text,
          chatGuid: session.chatGuid,
        },
        deps.config,
        deps.echoes,
      );
      if (delivery.sent > 0) {
        deps.state.markFallbackSent(key, now);
        log.info("fallback", "notice sent", {
          session: shortSession(key),
          unanswered: unanswered.length,
          owed_s: Math.round((now - session.lastInboundMs) / 1000),
        });
      } else if (delivery.errors.length > 0) {
        // Send path is unhealthy — don't stamp, the next sweep retries.
        log.warn("fallback", "notice send failed", {
          session: shortSession(key),
          err: delivery.errors[0]?.slice(0, 120),
        });
      }
    } catch (err) {
      log.error("fallback", "sweep error", {
        session: shortSession(key),
        err: String(err).slice(0, 200),
      });
    }
  }
}
