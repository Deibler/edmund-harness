import type { AgentStore } from "../agents/store.ts";
import type { OperatorAlert } from "../alerts/operator-alert.ts";
import type { BgJobStore } from "../background/store.ts";
import type { Config } from "../config/config.ts";
import { cancelInboundRetries, isInboundRetryEvent } from "../cron/retry-marker.ts";
import type { CronStore } from "../cron/store.ts";
import type { ChatDb } from "../imessage/db.ts";
import { ensureSandbox } from "../persona/sandbox.ts";
import type { EchoCache } from "../sessions/echo-cache.ts";
import { type SessionKey, isTradingSession } from "../sessions/key.ts";
import type { SessionLocks } from "../sessions/locks.ts";
import { type SessionRecord, StateStore } from "../sessions/store.ts";
import { log } from "../util/log.ts";
import type { FailureClass } from "./classify.ts";
import { HEALERS } from "./healers.ts";
import { loadUnansweredInbound, runRecoveryTurn } from "./turn.ts";

/**
 * Stuck-session recovery sweep. Replaces the old `stale-recovery.ts`
 * which fired a `[System recovery check]` cron event into the model.
 *
 * For each session where the user sent a message and we never replied
 * (lastInboundMs > lastOutboundMs) beyond the stale threshold, and
 * nothing's in flight, and we're outside cooldown, and the conversation
 * isn't too old:
 *
 *  1. Heal — if the last recorded error class has a known healer
 *     (request_too_large → compact, image_dim_exceeded → downscale,
 *     stale_session_id → drop the provider thread id), run it.
 *  2. Recovery turn — invoke the model with a recovery-context envelope
 *     (see `turn.ts`). The model gets honest internal context about
 *     what happened + the unanswered messages and decides whether to
 *     reply, stay silent, ack, or pivot.
 *
 * After many consecutive heal failures for the same session, fires a
 * single operator alert and stops trying.
 */

/**
 * Does `sessionKey` own this inbound row? The edmund DM and the trading (Wolf)
 * DM share one physical iMessage thread, so `loadUnansweredInbound` (chat-
 * scoped) can return the other persona's messages. We gate on the recorded
 * live routing decision:
 *   - recorded owner present → only that session may recover the row.
 *   - no record (pre-feature / very old) → belongs to the normal (edmund) path,
 *     never to a trading session. This guarantees a Wolf message is never
 *     recovered into edmund, and edmund's messages are never recovered into Wolf.
 */
export function ownsRow(state: StateStore, sessionKey: SessionKey, rowId: number): boolean {
  const owner = state.getRoutedSession(rowId);
  if (owner !== null) return owner === sessionKey;
  return !isTradingSession(sessionKey);
}

export const IMMINENT_CRON_MS = 60 * 1000;
export const REPLAY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7d — never reach further than that into history

type SweeperConfig = {
  staleThresholdMs: number;
  cooldownMs: number;
  maxAgeMs: number;
  maxHealFailuresBeforeAlert: number;
};

export type SweeperDeps = {
  config: Config;
  state: StateStore;
  agents: AgentStore;
  bgJobs: BgJobStore;
  crons: CronStore;
  chatDb: ChatDb;
  echoes: EchoCache;
  locks: SessionLocks;
  alert: OperatorAlert;
  activeSessions: Set<SessionKey>;
};

export async function sweepStuckSessions(
  deps: SweeperDeps,
  now: number = Date.now(),
): Promise<void> {
  if (!deps.config.recovery.enabled) return;
  const cfg: SweeperConfig = {
    staleThresholdMs: deps.config.recovery.stale_threshold_seconds * 1000,
    cooldownMs: deps.config.recovery.cooldown_minutes * 60_000,
    maxAgeMs: deps.config.recovery.max_age_hours * 3_600_000,
    maxHealFailuresBeforeAlert: deps.config.recovery.max_heal_failures_before_alert,
  };
  // Only sessions that owe a reply older than the stale threshold can
  // possibly need recovery — query that set directly rather than scanning
  // every session each sweep. `evaluateSession` re-checks everything anyway.
  for (const session of deps.state.listSessionsNeedingRecovery(now - cfg.staleThresholdMs)) {
    try {
      await sweepOne(session, cfg, deps, now);
    } catch (err) {
      log.error("recovery", "sweep error", {
        session: session.sessionKey,
        err: String(err).slice(0, 200),
      });
    }
  }
}

async function sweepOne(
  session: SessionRecord,
  cfg: SweeperConfig,
  deps: SweeperDeps,
  now: number,
): Promise<void> {
  const skip = evaluateSession(session, cfg, deps, now);
  if (skip) {
    if (process.env.DEBUG) {
      log.debug("recovery", "skip", { session: session.sessionKey, reason: skip });
    }
    return;
  }

  const errorClass = (session.lastErrorClass ?? "unknown") as FailureClass;
  const sandboxPath = ensureSandbox(session.sessionKey, null);

  // 1. Heal phase. Cheap when no healer is registered for the class.
  let healed = false;
  const healer = healerForSession(session, errorClass);
  if (healer) {
    try {
      const result = await healer(session.sessionKey, { state: deps.state, sandboxPath });
      healed = result.changed;
      if (!result.ok) {
        log.warn("recovery", "heal failed", {
          session: session.sessionKey,
          err_class: errorClass,
          detail: result.detail,
        });
        if (session.healAttemptsCount + 1 >= cfg.maxHealFailuresBeforeAlert) {
          await deps.alert.notify({
            category: "session recovery: heal failing repeatedly",
            error: `class=${errorClass} attempts=${session.healAttemptsCount + 1}`,
            context: { session: session.sessionKey },
          });
        }
        deps.state.recordError(session.sessionKey, errorClass, now);
        deps.state.markRecoveryAttempted(session.sessionKey, now);
        return;
      }
      if (result.changed) {
        log.info("recovery", "heal ok", {
          session: session.sessionKey,
          err_class: errorClass,
          detail: result.detail,
        });
      }
    } catch (err) {
      log.error("recovery", "heal threw", {
        session: session.sessionKey,
        err: String(err).slice(0, 200),
      });
      return;
    }
  }

  // 2. Load unanswered inbound from chat.db.
  const sinceMs = Math.max(session.lastOutboundMs, now - REPLAY_LOOKBACK_MS);
  const allUnanswered = loadUnansweredInbound(deps.chatDb, session.chatGuid, sinceMs);
  const unanswered = allUnanswered.filter(
    (m) =>
      !deps.state.wasReplayed(session.sessionKey, m.rowId) &&
      ownsRow(deps.state, session.sessionKey, m.rowId),
  );
  if (unanswered.length === 0) {
    if (process.env.DEBUG) {
      log.debug("recovery", "skip", {
        session: session.sessionKey,
        reason: "nothing unanswered (or all already replayed)",
      });
    }
    deps.state.markRecoveryAttempted(session.sessionKey, now);
    return;
  }

  // Alert (signature-deduped) when there's REAL unanswered work past the
  // max_age threshold. We previously fired this above evaluateSession but
  // BEFORE the unanswered check, which meant silenced/already-replayed
  // sessions kept re-alerting every sweep (they have last_inbound >
  // last_outbound but nothing actually to do — the model already handled
  // the rowIds). Only alert when we're about to do work the operator
  // would want to know about.
  //
  // Stable signature: include the session key in the error string so dedup
  // works PER SESSION. Previously the error rendered elapsed time via
  // humanDuration which rolls over from "1d" to "2d" (or "23h" to "1d"),
  // producing a new signature every few hours per session and bypassing
  // the 30-min dedup window. Each session should alert at most once per
  // configured interval, regardless of how the time string evolves.
  const elapsedSinceInbound = now - session.lastInboundMs;
  if (elapsedSinceInbound > cfg.maxAgeMs) {
    await deps.alert.notify({
      category: "session recovery: stuck past max_age",
      error: `session=${session.sessionKey} unanswered=${unanswered.length} — still attempting (see daemon.log)`,
      context: {
        last_error_class: session.lastErrorClass ?? "none",
        heal_attempts: session.healAttemptsCount,
        elapsed: humanDuration(elapsedSinceInbound),
      },
    });
  }

  // 3. Recovery turn — model sees the recovery envelope and decides.
  const result = await runRecoveryTurn(
    session.sessionKey,
    {
      errorClass,
      healed,
      rawError: null,
      unanswered,
      nowMs: now,
    },
    {
      config: deps.config,
      state: deps.state,
      chatDb: deps.chatDb,
      echoes: deps.echoes,
      locks: deps.locks,
    },
  );

  if (!result.ok) {
    log.error("recovery", "turn failed", {
      session: session.sessionKey,
      err: result.error,
    });
  } else {
    log.info("recovery", "turn delivered", {
      session: session.sessionKey,
      sent: result.sent,
      silenced: result.silenced,
      replayed_rows: result.replayedRowIds.length,
    });
    // Recovery answered (or deliberately silenced) the burst — any inbound
    // retries still queued for it are now stale; firing them would re-invoke
    // the model on a resolved failure.
    cancelInboundRetries(deps.crons, session.sessionKey);
  }
  deps.state.markRecoveryAttempted(session.sessionKey, now);
}

/** Claude transcript rewrites must never touch a Codex thread id. */
function healerForSession(session: SessionRecord, errorClass: FailureClass) {
  if (
    session.sessionBackend === "codex" &&
    (errorClass === "request_too_large" ||
      errorClass === "image_dim_exceeded" ||
      errorClass === "bad_tool_ids")
  ) {
    return null;
  }
  return HEALERS[errorClass];
}

/**
 * Skip-decision matrix. Returns a human reason on skip, null on go.
 * Same shape as the old stale-recovery.evaluateSession so the daemon
 * log of skips is unchanged for operators.
 */
function evaluateSession(
  session: SessionRecord,
  cfg: SweeperConfig,
  deps: SweeperDeps,
  now: number,
): string | null {
  if (session.lastInboundMs === 0) return "no inbound yet";
  if (session.lastOutboundMs >= session.lastInboundMs) return "already replied";

  const elapsed = now - session.lastInboundMs;
  if (elapsed < cfg.staleThresholdMs) return `too fresh (${humanDuration(elapsed)})`;
  // NOTE: previously this returned `too old (...)` for elapsed > maxAgeMs and
  // permanently abandoned the session. That silently buried stuck DMs once
  // they crossed 24h. Now we keep trying; sweepOne emits a one-shot operator
  // alert (rate-limited by signature) when crossing the threshold. The
  // cooldown still paces retries so we're not hammering.

  if (session.lastRecoveryAttemptMs > 0 && now - session.lastRecoveryAttemptMs < cfg.cooldownMs) {
    return `recovery cooldown (${humanDuration(now - session.lastRecoveryAttemptMs)} ago)`;
  }

  if (deps.activeSessions.has(session.sessionKey)) return "session lock held";

  const agentsInFlight = deps.agents
    .list({ parentSessionKey: session.sessionKey })
    .filter((a) => a.status === "pending" || a.status === "running");
  if (agentsInFlight.length > 0) return `${agentsInFlight.length} agent(s) in-flight`;

  const bgInFlight = deps.bgJobs
    .listForSession(session.sessionKey)
    .filter((j) => j.status === "pending" || j.status === "running");
  if (bgInFlight.length > 0) return `${bgInFlight.length} bg job(s) in-flight`;

  const activeCrons = deps.crons.listActive(session.sessionKey);
  // An inbound-retry chain already owns this failure (queued by
  // scheduleInboundRetry, fires up to 3× on a 5-min cadence). If the
  // sweeper ALSO ran a recovery turn in between those fires, the user
  // could get two model replies to the same failed burst. Defer until the
  // chain delivers (which cancels itself) or exhausts (rows go inactive).
  const retryChain = activeCrons.filter((c) => isInboundRetryEvent(c.systemEvent));
  if (retryChain.length > 0) return `inbound-retry chain active (${retryChain.length} queued)`;

  const imminent = activeCrons.filter((c) => c.nextFireMs < now + IMMINENT_CRON_MS);
  if (imminent.length > 0) {
    const next = imminent[0]?.nextFireMs;
    return `cron firing in ${next ? Math.round((next - now) / 1000) : "?"}s`;
  }

  return null;
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Delete any legacy `[System recovery check]` cron jobs queued during
 * the old stale-recovery implementation. Called once on daemon start
 * so we don't fire stale system-event envelopes after the upgrade.
 * Returns the count deleted (for the startup log).
 *
 * Also hard-deletes any historical `done`/`canceled` legacy rows that
 * accumulated before this helper existed — they don't fire, but they
 * inflate the table and complicate inspection. Audit on 2026-05-17
 * found 309 such rows in production.
 */
export function dropLegacyRecoveryCrons(crons: CronStore): number {
  let n = 0;
  // Hard-purge historical legacy rows (status != 'active'). Uses the
  // typed CronStore helper rather than reaching into private state.
  try {
    const purged = crons.hardDeleteInactiveByEventPattern("[System recovery check");
    if (purged > 0) n += purged;
  } catch (err) {
    log.warn("recovery", "legacy purge failed", { err: String(err).slice(0, 200) });
  }
  for (const job of crons.listActive()) {
    if (job.systemEvent.includes("[System recovery check")) {
      try {
        crons.cancel(job.id);
        n++;
      } catch {}
    }
  }
  return n;
}
// Avoid an unused-import error if a future refactor drops the import.
void StateStore;
