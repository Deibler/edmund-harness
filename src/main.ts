import { exec } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AgentStore } from "./agents/store.ts";
import { OperatorAlert } from "./alerts/operator-alert.ts";
import { AlertStore } from "./alerts/store.ts";
import { UndeliveredAlert } from "./alerts/undelivered.ts";
import { BgJobStore } from "./background/store.ts";
import { banner, highWaterMark } from "./boot/banner.ts";
import { runCatchUp } from "./boot/catchup.ts";
import { hardenHarnessPermissions } from "./boot/harden-permissions.ts";
import {
  ResourceGovernor,
  atomicStatusWriter,
  collectProcessTable,
} from "./boot/resource-governor.ts";
import { wireRecall } from "./boot/wire-recall.ts";
import { wireRecovery } from "./boot/wire-recovery.ts";
import { toPendingEntry, writePending } from "./bridge/session-queue.ts";
import { isBargeIn } from "./channels/barge-in.ts";
import { deliverReply, setSmsDeliverer } from "./channels/deliver.ts";
import type { Deps } from "./channels/deps.ts";
import { SessionPipeline } from "./channels/pipeline.ts";
import { handleBatch, shouldAccept } from "./channels/turn.ts";
import { checkLoadout, formatLoadoutReport } from "./claude/loadout-check.ts";
import {
  flushWorkerPool,
  getWorkerPoolStats,
  isWorkerPoolBusy,
  shutdownWorkerPool,
} from "./claude/runner.ts";
import { loadConfig } from "./config/config.ts";
import { startCreditsMaintenance } from "./credits/maintenance.ts";
import { fireJob } from "./cron/fire.ts";
import { Scheduler } from "./cron/scheduler.ts";
import { CronStore } from "./cron/store.ts";
import { maybeRunPersonaProbes, runWeeklyEvalIfDue } from "./evals/loop.ts";
import { guestGateFor } from "./gating/allowlist.ts";
import { intensityTable, resolveIntensity } from "./ghost/intensity.ts";
import { GhostObserver } from "./ghost/observer.ts";
import { sweepFireOutcomes } from "./ghost/outcomes.ts";
import { GhostPrefsStore, autoEnrollSessions } from "./ghost/prefs.ts";
import { setGhostAlertHook } from "./ghost/think.ts";
import { resolveDmTier } from "./guests/access.ts";
import { GuestStore } from "./guests/store.ts";
import {
  controlSocketPath,
  healMessagingRegistry,
  serveBridgeControl,
  startBridge,
  stopBridge,
} from "./imessage/bridge/index.ts";
import { ChatDb } from "./imessage/db.ts";
import { decodeMessageText } from "./imessage/decode.ts";
import { getGroupParticipants } from "./imessage/participants.ts";
import { configureSendVerification } from "./imessage/send.ts";
import { startWatcher } from "./imessage/watcher.ts";
import * as intSettings from "./integrations/settings.ts";
import { routeForMessage, sessionKeyForOrchestrator } from "./orchestrators/registry.ts";
import { sweepGroupArchives, sweepPersonArchives } from "./persona/archive.ts";
import { PersonMaintainer } from "./persona/maintainer-observer.ts";
import { reapSandboxCaches } from "./persona/sandbox-reaper.ts";
import { initSemaphore } from "./proactive/semaphore.ts";
import { hostAccess } from "./security/policy.ts";
import { AddressBook } from "./sessions/address-book.ts";
import { ContactBook } from "./sessions/contacts.ts";
import { EchoCache } from "./sessions/echo-cache.ts";
import {
  type SessionKey,
  chatIdFromKey,
  isDmSession,
  normalizeHandle,
  tradingKeyFor,
} from "./sessions/key.ts";
import { SkillCurator } from "./skills/curator-observer.ts";
import { createSmsChannel } from "./sms/channel.ts";
import { resolveTwilioCreds } from "./sms/creds.ts";
import { startSmsServer } from "./sms/server.ts";
import { ensureTwilioWebhooks } from "./sms/twilio-config.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execAsync = promisify(exec);
import type { TradingGateFn } from "./integrations/contracts.ts";
import { startIntegrationRuntimes, stopIntegrationRuntimes } from "./integrations/host.ts";
import {
  integrationExport,
  integrationExportSync,
  warmOptionalExports,
} from "./integrations/optional.ts";
import { initRegistryFromConfig } from "./integrations/registry.ts";
import { trimTransformerEmbeddingWorkers } from "./memory/embed-provider.ts";
import { RefreshWatcher, buildRefreshRepairEvent } from "./refresh/runner.ts";
import { RefreshScriptStore } from "./refresh/store.ts";
import { SessionLocks, sessionLockTimeoutMs } from "./sessions/locks.ts";
import { StateStore } from "./sessions/store.ts";
import { defaultProbe } from "./triggers/evaluate.ts";
import { DataTriggerStore } from "./triggers/store.ts";
import { DataTriggerWatcher } from "./triggers/watcher.ts";
import { installLogSink } from "./util/log-sink.ts";

const CURSOR_KEY = "imessage_rowid";

async function main() {
  const config = loadConfig();
  // Private umask and a sweep of what is already on disk: databases, logs,
  // secrets and the persona directory are for this account only.
  {
    const report = hardenHarnessPermissions(process.cwd(), resolve(config.paths.data_dir));
    if (report.errors.length > 0)
      console.warn("[boot] permission hardening", report.errors.join("; "));
  }
  // Build the integration registry from [integrations] before anything asks
  // for tools or runtimes.
  initRegistryFromConfig(config);
  // Pre-resolve integration exports the watcher reads synchronously.
  await warmOptionalExports();
  const logPath = installLogSink(config.paths.data_dir);
  console.log(`[edmund-harness] logging to ${logPath}`);

  // Export keys into the daemon's own env so modules (transcribe-inbound,
  // etc.) that use openai-http can read them. MCP subprocesses still get
  // their own copy via toolEnv().
  process.env.EDMUND_OPENAI_KEY = config.keys.openai;
  process.env.EDMUND_GEMINI_KEY = config.keys.gemini;
  process.env.EDMUND_ELEVENLABS_KEY = config.keys.elevenlabs;
  // Sub-agent runners (spawn.ts → agent-runner.ts) read this so the whole
  // agent tree uses the same effort level as the main session.
  process.env.EDMUND_EFFORT = config.claude.effort;
  process.env.EDMUND_AGENT_EFFORT = config.claude.agent_effort ?? config.claude.effort;
  if (config.claude.context_window_tokens) {
    process.env.EDMUND_CONTEXT_WINDOW_TOKENS = String(config.claude.context_window_tokens);
  } else {
    process.env.EDMUND_CONTEXT_WINDOW_TOKENS = undefined;
  }
  const chatDb = new ChatDb(config.paths.chat_db);
  // Own the bridge into Messages, and serve it to the rest of the harness.
  //
  // This is the only surface onto Messages. The supervisor keeps it up —
  // relaunching Messages when nothing else will, and noticing when the injected
  // side stops answering while the socket stays open, which is the failure no
  // amount of retrying a send can detect. Started before the watcher so inbound
  // events have something to attach to.
  //
  // Two things this replaces outright. There is no self-echo check against
  // chat.db to guess whether a timed-out send actually landed: every send now
  // carries an idempotency key, so a repeat returns the original result instead
  // of a second bubble. And there is no duplicate-instance sweeper: the injected
  // code announces its pid and a second instance is refused rather than left to
  // double every message.
  await startBridge({
    healthIntervalMs: config.imessage_send.health_interval_ms,
    healthTimeoutMs: config.imessage_send.health_timeout_ms,
    blockSelfSends: config.imessage_send.block_self_sends,
  });
  const bridgeControl = await serveBridgeControl(controlSocketPath(config.paths.data_dir));
  const state = new StateStore(config.paths.data_dir);
  // Keep the per-message routing record bounded — 30 days is well beyond the
  // recovery look-back window, so older rows can never affect a recovery decision.
  state.pruneRouting(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const crons = new CronStore(config.paths.data_dir);
  const addressBook = new AddressBook();
  const contacts = new ContactBook(config.contacts, addressBook);
  // Keyed guest access: activations, vouches, buffered unknown-sender
  // messages, caps. Shares state.db (the GhostPrefsStore pattern).
  const guests = new GuestStore(config.paths.data_dir);
  // A DM session whose handle resolves to a guest tier (or to nothing at
  // all) is excluded from proactive machinery — ghost outreach, enrollment.
  // The allowlist wins: a vouched handle that is ALSO allowlisted stays a
  // full operator session.
  const isGuestExcludedSession = (key: SessionKey): boolean => {
    if (!config.guest_access.enabled || !isDmSession(key)) return false;
    return resolveDmTier(chatIdFromKey(key), config, guests) !== "operator";
  };
  // Brown-nose: open the prefs store and auto-enroll any session that
  // doesn't yet have a row. Idempotent — re-runs on every boot, no-op
  // when everyone is already enrolled. See docs/design/brownnose-plan.md.
  const ghostPrefs = new GhostPrefsStore(config.paths.data_dir);
  if (config.brown_nose.enabled) {
    const intensityParams = resolveIntensity(config.brown_nose.intensity);
    const enrolled = autoEnrollSessions(
      ghostPrefs,
      state
        .listSessions()
        .map((s) => ({
          sessionKey: s.sessionKey as SessionKey,
          isGroup: s.isGroup === 1,
        }))
        // Guest/vouched DMs never enroll in proactive outreach.
        .filter((s) => !isGuestExcludedSession(s.sessionKey)),
      {
        dmEnabled: config.brown_nose.dms_enabled_by_default,
        groupEnabled: config.brown_nose.groups_enabled_by_default,
        timezone: config.brown_nose.default_timezone,
        weeklyCap: intensityParams.weeklyCap,
      },
    );
    if (enrolled > 0) {
      console.log(
        `[brown-nose] auto-enrolled ${enrolled} session${enrolled === 1 ? "" : "s"} ` +
          `(intensity ${config.brown_nose.intensity}, dm_default=${config.brown_nose.dms_enabled_by_default}, group_default=${config.brown_nose.groups_enabled_by_default})`,
      );
    }
    // Operator changed intensity? Restamp weekly caps still sitting on a
    // (now-stale) intensity default — caps were previously frozen at
    // enrollment, so "make it more aggressive" never reached them.
    const synced = ghostPrefs.syncWeeklyCapsToIntensity(
      intensityTable().map((r) => r.weeklyCap),
      intensityParams.weeklyCap,
    );
    if (synced > 0) {
      console.log(
        `[brown-nose] weekly caps synced to intensity ${config.brown_nose.intensity}: ${synced} session${synced === 1 ? "" : "s"} → ${intensityParams.weeklyCap}/wk`,
      );
    }
  }
  // Brown-nose concurrency guard — global cap across all sessions.
  initSemaphore({
    maxConcurrent: config.brown_nose.max_concurrent_fires,
    minSpacingMs: config.brown_nose.min_seconds_between_fires * 1000,
  });
  // Start the ghost observer. Phase 3: when ghost says act:true, the
  // observer enqueues a brown-nose cron row that the existing scheduler
  // picks up — fireJob routes [BROWN_NOSE] events to src/proactive/fire.ts.
  const ghostObserver = new GhostObserver({
    config,
    chatDb,
    contacts,
    prefs: ghostPrefs,
    crons,
    state,
    isExcludedSession: isGuestExcludedSession,
  });
  ghostObserver.start();
  // Engagement-outcome backfill: stamp engaged/ignored on proactive fires
  // from observable behavior (did the user text back within the window?).
  // Without this, every fire stays outcome=null forever and engagement
  // decay never learns. 10-min cadence is plenty — verdicts are hour-scale.
  const outcomeSweep = setInterval(
    () => {
      try {
        sweepFireOutcomes({ prefs: ghostPrefs, chatDb, state });
      } catch (err) {
        console.error("[brown-nose-outcome] sweep failed", err);
      }
    },
    10 * 60 * 1000,
  );
  outcomeSweep.unref?.();
  const echoes = new EchoCache();
  const personMaintainer = new PersonMaintainer({ config, state, chatDb, contacts });
  // Cross-conversation skill curation. Unlike the person maintainer this is
  // not reply-triggered — its whole premise is the pattern no single
  // conversation can see — so it runs on a wall clock and persists its own
  // last-run stamp, which is what keeps a daemon that restarts twice a day
  // from getting two passes out of it.
  const skillCurator = new SkillCurator({
    config,
    dataDir: config.paths.data_dir,
    skillsRoot: resolve(import.meta.dir, "..", "skills"),
    dbPath: resolve(config.paths.data_dir, config.skills_marketplace.installed_db),
    consentDbPath: resolve(config.paths.data_dir, config.public_skills.consent_db),
    contacts,
  });
  skillCurator.start();
  const alertStore = new AlertStore(config.paths.data_dir);
  const alert = new OperatorAlert({
    operatorHandle: config.alerts.operator_handle,
    minIntervalMinutes: config.alerts.min_interval_minutes,
    store: alertStore,
  });
  // Guest gate context for shouldAccept: the store plus the activation
  // alert ("<label> key activated by <handle>").
  const guestGate = guestGateFor(guests, alert);
  // Every send is checked against chat.db for where it actually landed. A
  // self-route first tries to clear on its own (soft resends); a persistent one
  // relaunches Messages to re-resolve the registry. imagent is deliberately
  // never restarted here — its churn leaves inbound receive stale. The operator
  // hears about it only when a message is genuinely lost, not on every catch.
  const undelivered = new UndeliveredAlert({ alert, state, chatDb });
  configureSendVerification({
    chatDbPath: config.paths.chat_db,
    selfHandles: config.self.handles,
    // Rebuild the registry when a self-route persists past the soft retries.
    // Silent on its own — recovery success is not worth an alert.
    onMisdelivery: (event) =>
      healMessagingRegistry(`${event.intended} → ${event.landedIdentifier}`),
    // Recovery rounds running out is not "the message never went" — the reply
    // is about to enter the durable outbox, which usually flushes within a
    // couple of minutes. The deferred alert re-checks ground truth after a
    // grace window and only tells the operator about a message still stuck.
    onUnrecovered: (event) => undelivered.report(event),
  });
  // Repeated ghost spawn failures (previously ~4.5% of ticks, silent)
  // escalate to the operator after 3 consecutive misses. OperatorAlert's
  // signature dedupe + min-interval already rate-limit it.
  setGhostAlertHook((category, error, context) => {
    void alert.notify({ category, error, context });
  });
  // Per-person generation credits: apply any top-up the dashboard did not,
  // and once a day check that the OpenRouter account can cover every
  // wallet's balance. Inert unless [credits].enabled.
  const creditsMaintenance = startCreditsMaintenance({ config, alert });
  // Eval loop v1: weekly judged transcript sample + persona-change probe
  // replay (both no-op unless due — the interval just gives them chances
  // to run). Post-boot delay keeps the judge off the boot path.
  const evalTick = () => {
    const deps = { config, chatDb, dataDir: config.paths.data_dir, alert };
    runWeeklyEvalIfDue(deps).catch((err) => console.error("[evals] weekly failed", err));
    maybeRunPersonaProbes(deps).catch((err) => console.error("[evals] probes failed", err));
  };
  const evalTimer = setInterval(evalTick, 6 * 3_600_000);
  evalTimer.unref?.();
  setTimeout(evalTick, 2 * 60_000).unref?.();
  const locks = new SessionLocks({
    // Liveness lease, not a wall-clock cap: the Claude worker heartbeats
    // the lock on every stream event, so an actively-working turn (however
    // long — a 40-minute video edit is legitimate) holds its lock until it
    // finishes. This ceiling only fires after that long with NO liveness
    // signal at all — and the worker's own idle timeout (1×, which actually
    // tears the subprocess down) fires first for worker hangs, so tripping
    // this means something outside a worker turn is genuinely wedged.
    // See sessionLockTimeoutMs.
    defaultTimeoutMs: sessionLockTimeoutMs(config.claude.timeout_seconds * 1000),
    onTimeout: (key, elapsedMs, timeoutMs) => {
      void alert.notify({
        category: "session lock stalled",
        error: `no liveness signal for ${Math.round((timeoutMs ?? 0) / 1000)}s (held ${Math.round(elapsedMs / 1000)}s total) — lock released, session unwedged`,
        context: { session: key },
      });
    },
  });
  const startCursor = state.getCursor(CURSOR_KEY, highWaterMark(chatDb));
  banner(config, startCursor, {
    addressBookSize: addressBook.size(),
    alertsTo: alert.enabled() ? config.alerts.operator_handle : null,
  });

  // Self-check: verify persona/* and skills/* are discoverable. If anything
  // is missing or empty, the daemon still starts — but the warning lines in
  // daemon.log let the operator spot it before the first conversation goes
  // sideways ("why is Edmund ignoring his persona?").
  const loadout = checkLoadout(config.claude.model);
  console.log(formatLoadoutReport(loadout));

  const activeSessions = new Set<SessionKey>();
  const turnControllers = new Map<SessionKey, AbortController>();

  const recall = wireRecall({ config, state, chatDb, contacts });

  // Dump claude-pool stats to disk every 30s so the dashboard (running in
  // a different process) can show live worker counts and miss rate. The
  // pool itself only logs every 10 min — too coarse for an operator UI.
  // Dashboard "Force run" button for the people maintainer. Body is JSON:
  // `{ at, sessionKey }`. If sessionKey is null we run every enrolled
  // session sequentially (cheap — runNow is async and the maintainer
  // already has its own min-interval guard, which we bypass).
  const peopleKickPath = `${config.paths.data_dir}/people-maintainer.kick`;
  const peopleKickTimer = setInterval(async () => {
    if (!existsSync(peopleKickPath)) return;
    let body: { sessionKey: string | null } = { sessionKey: null };
    try {
      body = JSON.parse(await Bun.file(peopleKickPath).text()) as { sessionKey: string | null };
    } catch {}
    try {
      unlinkSync(peopleKickPath);
    } catch {}
    if (body.sessionKey) {
      console.log(`[maintainer] dashboard force-run for ${body.sessionKey}`);
      await personMaintainer.runNow(body.sessionKey as SessionKey);
    } else {
      const sessions = state.listSessions();
      console.log(`[maintainer] dashboard force-run for ALL ${sessions.length} sessions`);
      for (const s of sessions) {
        await personMaintainer.runNow(s.sessionKey as SessionKey);
      }
    }
  }, 3000);
  if (typeof peopleKickTimer.unref === "function") peopleKickTimer.unref();

  const poolStatsTimer = setInterval(async () => {
    try {
      const flushPath = `${config.paths.data_dir}/pool-flush.kick`;
      if (existsSync(flushPath)) {
        try {
          unlinkSync(flushPath);
        } catch {}
        const n = await flushWorkerPool();
        console.log(`[claude-pool] dashboard flush kicked, evicted ${n} workers`);
      }
      const stats = getWorkerPoolStats();
      if (stats) {
        const path = `${config.paths.data_dir}/pool-stats.json`;
        const payload = {
          ...stats,
          enabled: config.claude.pool.enabled,
          maxWorkers: config.claude.pool.max_workers,
          windowStartMs: Date.now(),
        };
        writeFileSync(`${path}.tmp`, JSON.stringify(payload));
        renameSync(`${path}.tmp`, path);
      }
    } catch {}
  }, 5_000);
  if (typeof poolStatsTimer.unref === "function") poolStatsTimer.unref();

  const MIB = 1024 * 1024;
  const resourceGovernor = new ResourceGovernor(
    {
      softLimitBytes: config.resources.memory_soft_mb * MIB,
      hardLimitBytes: config.resources.memory_hard_mb * MIB,
      sustainedSamples: config.resources.sustained_samples,
      intervalMs: config.resources.sample_seconds * 1000,
      restartOnHardLimit: config.resources.restart_on_hard_limit,
    },
    {
      collectProcesses: collectProcessTable,
      getWorkerPids: () =>
        (getWorkerPoolStats()?.workers ?? [])
          .map((worker) => worker.pid)
          .filter((pid): pid is number => pid !== null),
      isBusy: isWorkerPoolBusy,
      flushWorkers: flushWorkerPool,
      trimEmbeddings: trimTransformerEmbeddingWorkers,
      collectMemory: () => process.memoryUsage(),
      gc: () => Bun.gc(true),
      requestRestart: () => {
        const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 250);
        timer.unref?.();
      },
      writeStatus: atomicStatusWriter(`${config.paths.data_dir}/resource-status.json`),
      now: Date.now,
      log: (level, message) => console[level](message),
    },
  );
  resourceGovernor.start();

  const deps: Deps = {
    config,
    state,
    contacts,
    echoes,
    chatDb,
    alert,
    crons,
    guests,
    activeSessions,
    turnControllers,
    ghostObserver,
    personMaintainer,
    autoRecall: recall.autoRecallClosure,
    locks,
  };

  const pipeline = new SessionPipeline({
    debounceMs: config.behavior.debounce_ms,
    voiceDebounceMs: config.behavior.voice_debounce_ms,
    maxMs: config.behavior.debounce_max_ms,
    captionedAttachmentMs: config.behavior.attachment_debounce_ms,
    bareAttachmentMs: config.behavior.bare_attachment_debounce_ms,
    handler: (key, batch) => handleBatch(key, batch, deps),
    locks,
  });
  deps.pipeline = pipeline;

  // ── SMS channel (Twilio) ──────────────────────────────────────────────
  // Inert unless [sms].enabled — no routes, no deliverer, no store. The
  // channel is the mirror pattern for a second time: synthetic inbounds on
  // the shared pipeline, a deliverer registered with channels/deliver.ts,
  // and history/roster provided to the envelope through deps.sms. Inbound
  // arrives only via the daemon's loopback webhook listener behind the named
  // Cloudflare tunnel, and every request is signature-validated before it is
  // believed. See src/sms/channel.ts for the routing truths.
  let smsRuntime: { stop: () => void } | null = null;
  if (config.sms.enabled) {
    const resolved = await resolveTwilioCreds();
    if (!resolved) {
      console.warn("[sms] enabled but Twilio credentials unresolved — channel not started");
    } else if (!config.sms.from) {
      console.warn("[sms] enabled but sms.from (our E.164) is unset — channel not started");
    } else {
      const smsChannel = createSmsChannel({
        config,
        creds: resolved.creds,
        pipeline,
        dataDir: config.paths.data_dir,
        ownNumber: config.sms.from,
        // "Known" = the operator can put a name to the number, via config
        // contacts or the macOS address book. The admission gate when no
        // explicit allowlist is configured.
        isKnownSender: (h) => contacts.displayName(h) !== null,
        statusCallbackUrl: config.sms.public_base_url
          ? `${config.sms.public_base_url.replace(/\/+$/, "")}/sms/status`
          : undefined,
      });
      setSmsDeliverer(smsChannel.deliverer);
      deps.sms = smsChannel.depsProviders;
      // Public origin resolution: an explicit public_base_url (a stable named
      // tunnel, someday) wins; otherwise the quick-tunnel URL file written by
      // run-sms-tunnel.sh is read PER REQUEST, because that hostname rotates
      // on every tunnel restart and a boot-time snapshot would go stale.
      const tunnelUrlFile = `${config.paths.data_dir}/sms-tunnel-url`;
      const publicBase = (): string | null => {
        if (config.sms.public_base_url) return config.sms.public_base_url;
        try {
          const url = readFileSync(tunnelUrlFile, "utf8").trim();
          return url.startsWith("https://") ? url : null;
        } catch {
          return null;
        }
      };
      // Self-healing: whenever the tunnel URL changes (boot, churn, restart),
      // re-point Twilio's Conversations webhook at it. ensureTwilioWebhooks
      // memoizes the applied URL, so the interval is a cheap file read.
      const repoint = async () => {
        const base = publicBase();
        if (base)
          await ensureTwilioWebhooks({
            creds: resolved.creds,
            publicBase: base,
            number: config.sms.from!,
          });
      };
      void repoint();
      const smsRepointInterval = setInterval(() => void repoint(), 60_000);
      // Cost reconciliation: sweep Twilio's billing records for posted prices
      // and fan-out children, true-up the sms ledger, forward actuals to
      // spend.db, and say where spend stands. 15 min matches how slowly
      // Twilio posts prices; the boot run backfills anything missed while
      // the daemon was down.
      const smsReconcile = async () => {
        const { reconcileSmsCosts } = await import("./sms/costs.ts");
        const r = await reconcileSmsCosts({
          creds: resolved.creds,
          store: smsChannel.store,
          dataDir: config.paths.data_dir,
          ownNumber: config.sms.from!,
        });
        if (!r) return;
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const day = smsChannel.store.spendSummary(midnight.getTime());
        const unrec = day.unreconciled ? `, ${day.unreconciled} awaiting posted price` : "";
        const found = r.discovered ? ` — discovered ${r.discovered} fan-out/out-of-band` : "";
        console.log(
          `[sms] spend today: $${day.totalUsd.toFixed(4)} (${day.inCount} in / ${day.outCount} out${unrec})${found}`,
        );
      };
      void smsReconcile();
      const smsReconcileInterval = setInterval(() => void smsReconcile(), 15 * 60_000);
      const smsServer = startSmsServer({
        port: config.sms.webhook_port,
        authToken: resolved.webhookAuthToken,
        publicBaseUrl: publicBase,
        onConversationMessage: smsChannel.onMessageAdded,
        onStatus: (p) => {
          const st = p.MessageStatus ?? p.SmsStatus ?? "?";
          // "sent" is a claim; these two are the truth arriving later.
          if (st === "undelivered" || st === "failed") {
            console.warn(
              `[sms] delivery failed sid=${p.MessageSid} status=${st} code=${p.ErrorCode ?? "?"}`,
            );
          }
        },
      });
      smsRuntime = {
        stop: () => {
          clearInterval(smsReconcileInterval);
          clearInterval(smsRepointInterval);
          setSmsDeliverer(null);
          smsServer.stop();
          smsChannel.store.close();
        },
      };
    }
  }

  const scheduler = new Scheduler({
    store: crons,
    onFire: (job) => fireJob(job, config, state, echoes, alert, locks, crons, ghostPrefs),
  });
  scheduler.start();

  // Safety-net: external processes (the per-turn MCP server subprocess,
  // agent-runner, recovery sweeper, etc.) can insert cron rows directly via
  // their own CronStore handle. The daemon's scheduler only rearms on its
  // own fireDue cycle or explicit poke, so those inserts would sit unseen.
  // A 2s heartbeat caps the worst-case latency at 2s — matters most for
  // relays from `send_to_user`, which want to fire as soon as the inserting
  // MCP turn finishes. (Was 15s; cron-fire is one nextDue() + clock check
  // when idle, so the extra ticks are essentially free.)
  const externalPoke = setInterval(() => scheduler.poke(), 2_000);

  // Integration runtimes (trading price-triggers, RadarOmega freshness
  // watchdog, the mirror bridge, …). Each package declares its runtime in
  // `manifest.yaml`; the registry imports and starts only the ones installed
  // AND enabled, so this block does not name any specific integration and an
  // absent package is simply a no-op.
  //
  // `fireSystemEvent` is the shared wake path: a watcher inserts a one-shot
  // cron row and pokes the scheduler, which picks it up within ~2s. That is
  // the same mechanism agent completions use — integrations get no private
  // route into a session.
  const integrationRuntimes = await startIntegrationRuntimes({
    config,
    isBusy: isWorkerPoolBusy,
    fireSystemEvent: (sessionKey, systemEvent) => {
      crons.create({
        sessionKey,
        systemEvent,
        schedule: { kind: "once", atMs: Date.now() + 1000 },
      });
      scheduler.poke();
    },
    // Channel capabilities. Granted to integrations that are a conversational
    // medium (the mirror) rather than a tool surface: they need to push turns
    // through the pipeline, interrupt one mid-flight, watch the model's
    // lifecycle, and register as a delivery target. A tool-only integration
    // never receives these.
    channel: {
      pipeline,
      interruptTurn: (sessionKey, reason) => {
        const controller = turnControllers.get(sessionKey);
        if (!controller || controller.signal.aborted) return false;
        controller.abort(reason);
        return true;
      },
      setLifecycle: (lifecycle) => {
        deps.mirrorLifecycle = lifecycle as typeof deps.mirrorLifecycle;
      },
      setDeliverer: (deliver) => {
        void import("./channels/deliver.ts").then(({ setMirrorDeliverer }) =>
          setMirrorDeliverer(deliver as Parameters<typeof setMirrorDeliverer>[0]),
        );
      },
    },
  });

  // Data-trigger watcher: model-authored watch conditions (URL probes or
  // JS evaluated inside the live RadarOmega app) checked here for free;
  // the model is invoked via one-shot cron only when a condition fires.
  let dataTriggerWatcher: DataTriggerWatcher | null = null;
  let dataTriggerStore: DataTriggerStore | null = null;
  if (config.triggers.enabled) {
    dataTriggerStore = new DataTriggerStore(config.paths.data_dir);
    dataTriggerWatcher = new DataTriggerWatcher({
      store: dataTriggerStore,
      intervalMs: config.triggers.tick_seconds * 1000,
      probe: defaultProbe(intSettings.radaromega(config).cdp_port, chatDb),
      fire: (sessionKey, systemEvent) => {
        crons.create({
          sessionKey,
          systemEvent,
          schedule: { kind: "once", atMs: Date.now() + 1000 },
        });
        scheduler.poke();
      },
      onError: (err) => console.error("[trigger-watcher] error", err),
      onPersistentFailure: (t, error, failures) => {
        void alert.notify({
          category: "trigger-persistent-failure",
          error: `${t.name} (${t.id}): ${error}`,
          context: {
            session: t.sessionKey,
            consecutiveFailures: failures,
            note: "checks backing off up to 1h — fix or cancel via list_triggers/cancel_trigger",
          },
        });
      },
      onAutoDisarm: (t, error, failures) => {
        void alert.notify({
          category: "trigger-auto-disarmed",
          error: `${t.name} (${t.id}): ${error}`,
          context: {
            session: t.sessionKey,
            consecutiveFailures: failures,
            note: "the endpoint never came back, so this trigger is now disarmed and will not be checked again — recreate it with set_trigger once the URL is live",
          },
        });
      },
    });
    if (hostAccess(config) === "full") {
      dataTriggerWatcher.start();
    } else {
      console.log(
        '[trigger-watcher] not started: data triggers run model-authored predicates; set [security].model_host_access = "full" to enable',
      );
    }
    const armed = dataTriggerStore.listArmed().length;
    console.log(`[triggers] data-trigger watcher started (${armed} armed)`);
  }

  // Person-file size gate: shrink any oversized live profile by moving
  // its oldest history bullets to the append-only archive (indexed +
  // searchable — nothing deleted). Runs once at boot; the maintainer
  // re-runs it per file after each append.
  try {
    const swept = sweepPersonArchives();
    const sweptGroups = sweepGroupArchives();
    const files = swept.files + sweptGroups.files;
    if (files > 0) {
      console.log(
        `[persona-archive] archived ${swept.moved + sweptGroups.moved} aged bullets from ${files} oversized file(s)`,
      );
    }
  } catch (err) {
    console.warn(`[persona-archive] boot sweep failed: ${(err as Error).message}`);
  }

  // Refresh-script watcher: model-authored DETERMINISTIC recurring actions
  // (e.g. the mirror weather widget). The daemon runs the script + applies
  // its output on schedule with zero model turns; the owning session's
  // model is woken (one-shot cron) only when a script fails persistently.
  const refreshStore = new RefreshScriptStore(config.paths.data_dir);
  const refreshWatcher = new RefreshWatcher({
    store: refreshStore,
    intervalMs: 60_000,
    apply: async (script, value) => {
      if (script.applyKind === "mirror_content") {
        type MirrorApply = (
          dataDir: string,
          cfg: typeof config,
          v: unknown,
        ) => { ok: true; summary: string } | { ok: false; error: string };
        const apply = await integrationExport<MirrorApply>(
          "mirror",
          "refresh.ts",
          "applyMirrorRefresh",
        );
        if (!apply) return { ok: false, error: "mirror integration unavailable" };
        return apply(config.paths.data_dir, config, value);
      }
      return { ok: false, error: `unknown apply kind: ${script.applyKind}` };
    },
    escalate: (script, error, failures) => {
      crons.create({
        sessionKey: script.sessionKey,
        systemEvent: buildRefreshRepairEvent(script, error, failures),
        schedule: { kind: "once", atMs: Date.now() + 1000 },
      });
      scheduler.poke();
    },
    onError: (err) => console.error("[refresh-watcher] error", err),
  });
  if (hostAccess(config) === "full") {
    refreshWatcher.start();
  } else {
    console.log(
      '[refresh] not started: refresh scripts are model-authored code; set [security].model_host_access = "full" to enable',
    );
  }
  console.log(`[refresh] script watcher started (${refreshStore.listArmed().length} armed)`);

  // Sandbox cache reaper: every 6h sweep machine-generated assets
  // (screenshots, PDFs, .resized images, .inline-images, bg cf-execute
  // outputs) older than 7 days from every sandbox. Caps disk use
  // without depending on session eviction (which may never happen for
  // a healthy long-running thread). Synchronous fs walk on a 6h
  // cadence is cheap. Fires once at boot too, so a long-running
  // daemon doesn't have to wait 6h for the first sweep after restart.
  const SANDBOX_REAP_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const SANDBOX_REAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const sandboxRoot = `${process.cwd()}/sandbox`;
  const runSandboxReap = () => {
    try {
      reapSandboxCaches({ sandboxRoot, maxAgeMs: SANDBOX_REAP_MAX_AGE_MS });
    } catch (err) {
      console.error("[sandbox-reaper] failed", err);
    }
  };
  runSandboxReap();
  const sandboxReapInterval = setInterval(runSandboxReap, SANDBOX_REAP_INTERVAL_MS);
  sandboxReapInterval.unref?.();

  // Instant-share leases are external processes by design, so they need an
  // independent clock: the served page cannot be responsible for receiving a
  // request after its own expiry. The reaper validates every recorded PID and
  // quick-tunnel command before signaling; named Cloudflare tunnels are never
  // candidates.
  let instantShareReapRunning = false;
  const runInstantShareReap = async () => {
    if (instantShareReapRunning) return;
    instantShareReapRunning = true;
    try {
      const script = resolve(REPO_ROOT, "skills/instant-share/scripts/reap.py");
      const configDir = resolve(config.paths.data_dir, "instant-share");
      const proc = Bun.spawn(["python3", script, "--config-dir", configDir, "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        console.warn(
          `[instant-share] lease reaper failed (${code}): ${stderr.trim().slice(0, 300)}`,
        );
        return;
      }
      const result = JSON.parse(stdout) as {
        stopped?: number;
        expired?: number;
        stale?: number;
      };
      if ((result.stopped ?? 0) + (result.stale ?? 0) > 0) {
        console.log(
          `[instant-share] lease reaper: stopped=${result.stopped ?? 0} ` +
            `expired=${result.expired ?? 0} stale=${result.stale ?? 0}`,
        );
      }
    } catch (error) {
      console.warn(`[instant-share] lease reaper error: ${(error as Error).message}`);
    } finally {
      instantShareReapRunning = false;
    }
  };
  void runInstantShareReap();
  const instantShareReapInterval = setInterval(() => void runInstantShareReap(), 60_000);
  instantShareReapInterval.unref?.();

  const agentStore = new AgentStore(config.paths.data_dir);
  const bgJobStore = new BgJobStore(config.paths.data_dir);
  // Belt-and-suspenders cleanup after the 2026-05-18 wake-recovery
  // spam: (a) suppress any old finished-without-wake rows so the
  // reaper can't fire on them, (b) cancel any pending recovery-cron
  // envelopes the prior buggy run left queued. The migration backfill
  // in BgJobStore handles fresh boots; this catches a daemon that
  // was killed mid-spam with the column already present.
  const suppressedOld = bgJobStore.suppressOldMissedWakes(60 * 60 * 1000);
  if (suppressedOld > 0) {
    console.warn(
      `[bg-jobs] startup: suppressed ${suppressedOld} stale missed-wake rows (older than 1h)`,
    );
  }
  const purgedRecoveryCrons = crons.hardDeleteInactiveByEventPattern(
    "recovered by reaper after crash",
  );
  const cancelledRecoveryCrons = (() => {
    let n = 0;
    for (const job of crons.listActive()) {
      if (job.systemEvent.includes("recovered by reaper after crash")) {
        try {
          if (crons.cancel(job.id)) n++;
        } catch {}
      }
    }
    return n;
  })();
  if (purgedRecoveryCrons + cancelledRecoveryCrons > 0) {
    console.warn(
      `[bg-jobs] startup: cleaned up ${cancelledRecoveryCrons} active + ${purgedRecoveryCrons} historical recovery-cron rows`,
    );
  }
  // Recovery catch-up: if a backlog piled up while the daemon was down, coalesce it per chat
  // into ONE turn each (bounded concurrency) and tell the model it was offline — instead of
  // replaying message-by-message, which fired one reply per missed message (group-chat spam)
  // and swamped the worker pool on recovery. The live watcher then starts from the post-catch-up
  // cursor so it only handles genuinely new messages. No-op when nothing was missed.
  let watchCursor = startCursor;
  if (config.behavior.catchup_on_boot !== false) {
    try {
      watchCursor = await runCatchUp({
        deps,
        locks,
        startCursor,
        concurrency: config.behavior.catchup_concurrency ?? 3,
      });
      state.setCursor(CURSOR_KEY, watchCursor);
    } catch (err) {
      console.error("[catchup] recovery catch-up failed; falling back to live replay", err);
    }
  }

  // Recovery loops start strictly AFTER catch-up has drained. Wiring them
  // earlier let the sweeper (and the fallback-notice sweep) race the boot
  // backlog: a chat whose coalesced catch-up turn was still queued looked
  // "stuck" — old unanswered inbound, no lock held yet — so recovery fired
  // a second model turn (double reply) and the fallback sweep could spray
  // "still on it" notices across every backlogged thread at boot.
  const { recoveryInterval, reaperInterval, outboxDrainInterval } = wireRecovery({
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
  });

  const stop = startWatcher({
    chatDb,
    chatDbPath: config.paths.chat_db,
    startCursor: watchCursor,
    source: config.imessage_watcher.source,
    onMessage: (msg) => {
      // Vouching: any traffic in a registered group — mentioned or not —
      // records every participant as vouched (co-membership is the
      // credential, not being replied to). Best-effort; a chat.db read
      // failure must not stall the inbound path.
      if (config.guest_access.enabled && msg.isGroup && !msg.fromMe) {
        const registered =
          config.allowlist.groups.length === 0 || config.allowlist.groups.includes(msg.chatGuid);
        if (registered) {
          try {
            guests.recordVouches(
              [msg.fromHandle, ...getGroupParticipants(chatDb, msg.chatGuid)].filter(Boolean),
              msg.chatGuid,
            );
          } catch (err) {
            console.warn(`[guest] vouch recording failed: ${(err as Error).message}`);
          }
        }
      }
      // Cursor only advances AFTER we've successfully accepted-and-routed the
      // row. If shouldAccept rejects it, that's still a definitive disposition
      // (drop), so advance. If pipeline.enqueue / writePending throws, we
      // leave the cursor in place — the next drain will retry the same row
      // and the watcher's onConsecutiveErrors alert will fire if it keeps
      // failing. Prevents the "silent message loss on enqueue failure" bug.
      if (!shouldAccept(msg, config, echoes, guestGate)) {
        state.setCursor(CURSOR_KEY, msg.rowId);
        return;
      }
      // Trading sub-persona routing: an eligible handle that has switched into
      // the trading persona is keyed into the `trading:dm:` namespace, which
      // carries the trading loadout (persona + Robinhood tools) everywhere
      // downstream. The two-handle restriction is enforced here, before the
      // key is computed, independent of allowlist.dm.
      //
      // Otherwise, named-orchestrator routing (same per-message, no-stickiness
      // model): a message that names a configured orchestrator ("desmond, …")
      // is keyed into that orchestrator's namespace; an un-named message goes
      // to the primary. With no [[orchestrators]] configured this collapses
      // to the legacy sessionKeyFor — byte-identical routing.
      const key =
        integrationExportSync<TradingGateFn>("trading", "index.ts", "tradingGate")?.(
          msg,
          config,
          state,
        )?.route === "trading"
          ? tradingKeyFor(msg.fromHandle)
          : sessionKeyForOrchestrator(routeForMessage(msg.text, config), msg, contacts);

      // On-demand Cloudflare dashboard tunnel trigger for the operator DM
      if (!msg.isGroup && msg.fromHandle && config.alerts.operator_handle) {
        const normSender = normalizeHandle(msg.fromHandle);
        const normOperator = normalizeHandle(config.alerts.operator_handle);
        if (normSender === normOperator && msg.text.trim().toLowerCase() === "harness") {
          console.log(`[harness-trigger] operator requested dashboard tunnel`);
          void (async () => {
            try {
              await deliverReply(
                {
                  to: chatIdFromKey(key),
                  isGroup: false,
                  text: "Bringing up mobile dashboard tunnel...",
                  // Pinned: an unpinned DM send resolves to note-to-self.
                  chatGuid: msg.chatGuid,
                },
                config,
                echoes,
              );

              const scriptPath = resolve(REPO_ROOT, "scripts/dashboard-tunnel.sh");
              const { stdout } = await execAsync(`bash ${scriptPath} up`);
              const url = stdout.trim();

              if (url?.startsWith("https://")) {
                await deliverReply(
                  {
                    to: chatIdFromKey(key),
                    isGroup: false,
                    text: `Dashboard is live at:\n\n${url}\n\nThis tunnel will expire in 4 hours. Use your dashboard PIN to log in.`,
                    // Pinned: an unpinned DM send resolves to note-to-self.
                    chatGuid: msg.chatGuid,
                  },
                  config,
                  echoes,
                );
              } else {
                throw new Error(url || "No URL returned");
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.error(`[harness-trigger] failed to bring up tunnel:`, err);
              await deliverReply(
                {
                  to: chatIdFromKey(key),
                  isGroup: false,
                  text: `Failed to bring up dashboard tunnel: ${errMsg}`,
                  // Pinned: an unpinned DM send resolves to note-to-self.
                  chatGuid: msg.chatGuid,
                },
                config,
                echoes,
              );
            }
          })();

          state.setCursor(CURSOR_KEY, msg.rowId);
          return;
        }
      }

      // Record which session owns this row so chat-scoped recovery / catch-up
      // (which share the physical DM thread) never replay a Wolf message into
      // edmund or vice-versa.
      state.recordRouting(msg.rowId, key);
      // Durable ack BEFORE the cursor can advance: until a turn answers this
      // row (handleBatch clears acks it covered), state.db holds enough to
      // rebuild it. A daemon killed inside the debounce window used to lose
      // the row forever (cursor already past it, no other durable record —
      // the 2026-07-19 10:21 incident); boot now replays ack survivors
      // through the catch-up coalescer. Throws propagate so the cursor stays
      // put and the watcher retries the row.
      if (config.behavior.durable_pending_ack) {
        state.writeInboundAck(msg.rowId, key, JSON.stringify(toPendingEntry(msg)));
      }
      if (activeSessions.has(key)) {
        writePending(key, msg, config.paths.data_dir);
        // Barge-in: a clear cancel/redirect aborts the in-flight turn NOW
        // instead of letting doomed work finish (or a slow tool chain run
        // minutes past a "stop"). The abort path disposes the old batch
        // (ack-covered — user superseded it) and handleBatch's finally
        // re-enqueues this parked message as its own fresh turn, so the
        // model answers the cancel/pivot in seconds.
        if (isBargeIn(msg.text)) {
          const controller = turnControllers.get(key);
          if (controller && !controller.signal.aborted) {
            console.log(
              `[barge-in] aborting in-flight turn for ${key}: "${(msg.text ?? "").slice(0, 80)}"`,
            );
            controller.abort(`user barge-in: ${(msg.text ?? "").slice(0, 80)}`);
          }
        }
        // With the coalesce gate on, the parked message is folded into the
        // current turn's reply (or re-enqueued by the gate if the model
        // keeps its draft). With the gate off, fall back to legacy behavior:
        // it becomes the next proper turn.
        if (config.behavior.coalesce_pending) {
          state.setCursor(CURSOR_KEY, msg.rowId);
          return;
        }
      }
      pipeline.enqueue(key, msg);
      state.setCursor(CURSOR_KEY, msg.rowId);
    },
    onError: (err) => console.error("[watcher] error", err),
    onConsecutiveErrors: (count, lastError) => {
      void alert.notify({
        category: "watcher: inbound handler failing repeatedly",
        error: `${count} consecutive onMessage failures (rows are being dropped); last: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      });
    },
  });

  const shutdown = async () => {
    console.log("[edmund-harness] shutting down");
    clearInterval(externalPoke);
    clearInterval(outcomeSweep);
    clearInterval(poolStatsTimer);
    resourceGovernor.stop();
    // Integration runtimes own their own teardown (watchers, bridges, stores,
    // speech sidecars). Failures are isolated per-integration so one hung
    // plugin can't block the rest of shutdown.
    await stopIntegrationRuntimes(integrationRuntimes);
    smsRuntime?.stop();
    creditsMaintenance.stop();
    dataTriggerWatcher?.stop();
    dataTriggerStore?.close();
    refreshWatcher.stop();
    refreshStore.close();
    clearInterval(sandboxReapInterval);
    clearInterval(instantShareReapInterval);
    clearInterval(reaperInterval);
    clearInterval(outboxDrainInterval);
    clearInterval(recoveryInterval);
    if (recall.interval) clearInterval(recall.interval);
    if (recall.store) recall.store.close();
    await bridgeControl.close();
    // Leaves Messages.app running — the daemon exiting is not a reason to close
    // the operator's messaging client.
    await stopBridge();
    scheduler.stop();
    personMaintainer.stop();
    skillCurator.stop();
    ghostObserver.stop();
    stop();
    // Drain any resident claude workers so their session JSONLs flush
    // cleanly. Bounded — pool.stop() gives each worker 2s grace then SIGTERMs.
    try {
      await shutdownWorkerPool();
    } catch (err) {
      console.error("[shutdown] worker pool drain error", err);
    }
    crons.close();
    state.close();
    chatDb.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
