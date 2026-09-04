import { existsSync, unlinkSync } from "node:fs";
import { reapStuckAgents } from "../agents/reaper.ts";
import type { AgentStore } from "../agents/store.ts";
import type { OperatorAlert } from "../alerts/operator-alert.ts";
import { reapStuckBgJobs } from "../background/reaper.ts";
import type { BgJobStore } from "../background/store.ts";
import type { Config } from "../config/config.ts";
import type { CronStore } from "../cron/store.ts";
import type { ChatDb } from "../imessage/db.ts";
import { sweepFallbackNotices } from "../recovery/fallback.ts";
import { startOutboxDrainer } from "../recovery/outbox-drainer.ts";
import { dropLegacyRecoveryCrons, sweepStuckSessions } from "../recovery/sweeper.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import type { EchoCache } from "../sessions/echo-cache.ts";
import type { SessionKey } from "../sessions/key.ts";
import type { SessionLocks } from "../sessions/locks.ts";
import type { StateStore } from "../sessions/store.ts";
import { FailureEscalator } from "../util/failure-escalator.ts";

/**
 * Wire up the two background loops the daemon needs for liveness:
 *
 *   1. **recovery sweep** — per-session check for unanswered inbounds.
 *      Heals known structural errors (32MB request limit, oversized images,
 *      stale Claude session ids) and invokes the model with a recovery
 *      envelope so it decides whether to reply. Rate is from
 *      `config.recovery.sweep_interval_seconds`; an escalator alerts the
 *      operator once if the sweep itself fails repeatedly.
 *
 *   2. **zombie reaper** — sweeps stuck sub-agents + bg jobs every 60s.
 *      Covers cases the in-runner reaper can't (solo agents that hang
 *      without exiting, teams where every member died silently, crashed
 *      bg-runners that never fired their on-exit wake-up).
 *
 * Returns the two interval handles so the shutdown path can clear them.
 */
export function wireRecovery(args: {
  config: Config;
  state: StateStore;
  chatDb: ChatDb;
  contacts: ContactBook;
  echoes: EchoCache;
  crons: CronStore;
  alert: OperatorAlert;
  locks: SessionLocks;
  agentStore: AgentStore;
  bgJobStore: BgJobStore;
  activeSessions: Set<SessionKey>;
}): {
  recoveryInterval: ReturnType<typeof setInterval>;
  reaperInterval: ReturnType<typeof setInterval>;
  outboxDrainInterval: ReturnType<typeof setInterval>;
} {
  const {
    config,
    state,
    chatDb,
    contacts,
    echoes,
    crons,
    alert,
    locks,
    agentStore,
    bgJobStore,
    activeSessions,
  } = args;

  if (config.recovery.enabled) {
    const dropped = dropLegacyRecoveryCrons(crons);
    if (dropped > 0) {
      console.log(`[recovery] dropped ${dropped} legacy [System recovery check] cron(s)`);
    }
  }
  // If the sweep throws every cycle (DB lock, corrupt row, a bug), it would
  // otherwise just log forever and recovery would silently never run. After
  // a run of failures: alert the operator once and thin the cycles.
  const recoveryEscalator = new FailureEscalator({
    name: "recovery-sweep",
    threshold: 5,
    onEscalate: (n, err) => {
      void alert.notify({
        category: "recovery sweep failing repeatedly",
        error: `${n} consecutive failures; last: ${err instanceof Error ? err.message : String(err)}`,
      });
    },
    onRecover: (after) => console.log(`[recovery] sweep recovered after ${after} failures`),
  });
  // One sweep pass = deliver real replies (sweepStuckSessions), then send
  // the per-burst "still on it" backstop for anything STILL unanswered past
  // the fallback deadline (sweepFallbackNotices). Ordered so a recovery turn
  // that just delivered suppresses the notice on the same tick.
  // `bootedAtMs` is stamped here — wireRecovery is called AFTER boot catch-up
  // drains, so the fallback's boot-grace window starts when live duty does.
  const bootedAtMs = Date.now();
  const runSweep = async (): Promise<void> => {
    await sweepStuckSessions({
      config,
      state,
      agents: agentStore,
      bgJobs: bgJobStore,
      crons,
      chatDb,
      echoes,
      locks,
      alert,
      activeSessions,
    });
    await sweepFallbackNotices({
      config,
      state,
      chatDb,
      echoes,
      activeSessions,
      agents: agentStore,
      bgJobs: bgJobStore,
      crons,
      bootedAtMs,
    });
  };

  // Dashboard "Force sweep" button: poll for a sentinel file faster than
  // the regular sweep interval so the button is responsive. The sweep is
  // idempotent; an extra one between intervals is harmless.
  const sweepKickPath = `${config.paths.data_dir}/recovery-sweep.kick`;
  const checkKick = (): boolean => {
    if (!existsSync(sweepKickPath)) return false;
    try {
      unlinkSync(sweepKickPath);
    } catch {}
    console.log("[recovery] dashboard sweep kick received");
    return true;
  };
  const kickWatcher = setInterval(() => {
    if (checkKick() && !recoveryEscalator.shouldSkip()) {
      runSweep().then(
        () => recoveryEscalator.recordSuccess(),
        (err) => recoveryEscalator.recordFailure(err),
      );
    }
  }, 2000);
  void kickWatcher;
  const recoveryInterval = setInterval(() => {
    if (recoveryEscalator.shouldSkip()) return;
    runSweep().then(
      () => recoveryEscalator.recordSuccess(),
      (err) => recoveryEscalator.recordFailure(err),
    );
  }, config.recovery.sweep_interval_seconds * 1000);

  // Delivery retries on their own clock, so a queued reply no longer waits
  // for the person to write again before it goes out.
  const outboxDrainInterval = startOutboxDrainer({ state, config, echoes, chatDb, contacts });

  const reaperInterval = setInterval(() => {
    try {
      reapStuckAgents(agentStore, crons, {
        pendingStaleMs: 60_000,
        runningStaleMs: 15 * 60 * 1000,
      });
    } catch (err) {
      console.error("[reaper] agents error", err);
    }
    // Bg-job reaper: catches crashed bg-runner processes. Pending >60s =
    // runner never started (spawn silently failed). Running >20min = runner
    // crashed without firing its on-exit wake-up. Without this, the session
    // would never get invoked again for that job.
    try {
      reapStuckBgJobs(bgJobStore, crons, {
        pendingStaleMs: 60_000,
        runningStaleMs: 20 * 60 * 1000,
      });
    } catch (err) {
      console.error("[reaper] bg-jobs error", err);
    }
  }, 60_000);

  return { recoveryInterval, reaperInterval, outboxDrainInterval };
}
