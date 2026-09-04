import { type OperatorAlert, isOperatorActionable, isRetryable } from "../alerts/operator-alert.ts";
import { parseInboundDepth } from "../bridge/relay.ts";
import { deliverReply } from "../channels/deliver.ts";
import type { Config } from "../config/config.ts";
import type { GhostPrefsStore } from "../ghost/prefs.ts";
import { isPermanentSendError } from "../imessage/send.ts";
import { compactConfigFor, reanchorCodexIfNeeded, runModel } from "../model/runner.ts";
import { ensureSandbox } from "../persona/sandbox.ts";
import { fireBrownNose } from "../proactive/fire.ts";
import { isBrownNoseEvent } from "../proactive/queue.ts";
import type { EchoCache } from "../sessions/echo-cache.ts";
import { chatIdFromKey, isGroupSession } from "../sessions/key.ts";
import type { SessionLocks } from "../sessions/locks.ts";
import type { StateStore } from "../sessions/store.ts";
import { recordSpend } from "../spend/ledger.ts";
import { humanMs, log, snippet } from "../util/log.ts";
import { inboundRetryAlreadyAnswered } from "./retry-marker.ts";
import type { CronStore } from "./store.ts";
import type { CronJob } from "./types.ts";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * Fire a cron job: resume the session, tell the model the event happened,
 * capture its reply, deliver via iMessage (chunked + sanitized same as a
 * normal inbound reply).
 *
 * Session lock: cron fires share `SessionLocks` with inbound handling so
 * scheduled events can't race a concurrent provider-thread resume.
 *
 * Retry: if the run fails with a retryable error (auth/quota/binary
 * missing, timeouts, transient network/process errors), we queue a
 * one-shot retry in 5 minutes up to 3 attempts total. Operator-actionable
 * subsets (auth/quota/binary) also fire an iMessage alert. The original
 * recurring job still advances as normal — this way a daily cron that
 * missed due to auth expiry or a timeout will catch up shortly after the
 * condition clears, instead of going silent until tomorrow.
 */
export async function fireJob(
  job: CronJob,
  config: Config,
  state: StateStore,
  echoes: EchoCache,
  alert: OperatorAlert,
  locks: SessionLocks,
  crons: CronStore,
  ghostPrefs: GhostPrefsStore,
): Promise<void> {
  // Brown-nose route: cron rows enqueued by the ghost have a tagged
  // systemEvent. They use a different envelope shape (no "scheduled
  // event" framing), recheck budgets, and respect the global
  // concurrency semaphore.
  if (isBrownNoseEvent(job.systemEvent)) {
    await locks.withLock(job.sessionKey, async () => {
      await fireBrownNose(job, config, state, echoes, crons, ghostPrefs, () =>
        locks.touch(job.sessionKey),
      );
    });
    return;
  }

  const session = state.getSession(job.sessionKey);
  if (!session) {
    console.warn(`[cron] ${job.id}: no session record for ${job.sessionKey}, skipping`);
    return;
  }

  // Inbound-retry staleness guard. Successful turns cancel these rows
  // (cancelInboundRetries), but one can still fire if it was queued before
  // a daemon restart or raced the cancel. If the session no longer owes a
  // reply, the burst this retry was queued for has been answered — firing
  // would re-invoke the model on a resolved failure and produce a second,
  // out-of-context reply. Requires the outbound to postdate the retry's
  // creation: a mid-turn tool send from BEFORE the failure doesn't count
  // as the answer (see inboundRetryAlreadyAnswered).
  if (inboundRetryAlreadyAnswered(job, session)) {
    log.info("cron", "skip stale inbound retry (answered after failure)", {
      job: job.id,
      session: job.sessionKey,
    });
    return;
  }

  // Grace period: if the job is firing significantly after its scheduled
  // time (daemon was down, auth issues, etc.), skip it rather than deliver
  // a stale morning brief at noon. One-shot system events (pokes, retries,
  // agent-done) have gracePeriodMs=null and always fire.
  if (job.gracePeriodMs !== null && job.gracePeriodMs !== undefined) {
    const latenessMs = Date.now() - job.nextFireMs;
    if (latenessMs > job.gracePeriodMs) {
      const lateMin = Math.round(latenessMs / 60_000);
      const graceMin = Math.round(job.gracePeriodMs / 60_000);
      log.warn("cron", `skip stale job (${lateMin}m late, grace=${graceMin}m)`, {
        job: job.id,
        scheduled: new Date(job.nextFireMs).toISOString(),
      });
      return;
    }
  }

  await locks.withLock(job.sessionKey, async () => {
    await runAndDeliver(job, config, state, echoes, alert, crons, session.chatGuid, () =>
      locks.touch(job.sessionKey),
    );
  });
}

async function runAndDeliver(
  job: CronJob,
  config: Config,
  state: StateStore,
  echoes: EchoCache,
  alert: OperatorAlert,
  crons: CronStore,
  chatGuid: string,
  onHeartbeat?: () => void,
): Promise<void> {
  const now = Date.now();
  const latenessMs = now - job.nextFireMs;
  const latenessNote = latenessMs > 90_000 ? ` · ${Math.round(latenessMs / 60_000)}m late` : "";
  const envelope = [
    `[Scheduled event · scheduled=${new Date(job.nextFireMs).toISOString()} fired=${new Date(now).toISOString()}${latenessNote}]`,
    "",
    job.systemEvent,
  ].join("\n");

  const kind = classifyEvent(job.systemEvent);
  log.info("cron", `fire ${kind}`, {
    job: job.id,
    session: job.sessionKey,
    schedule: job.schedule.kind,
    event: snippet(job.systemEvent, 140),
  });
  const started = Date.now();

  const sandboxPath = ensureSandbox(job.sessionKey, null);
  const result = await runModel(
    {
      sessionKey: job.sessionKey,
      envelope,
      senderLabel: "scheduler",
      senderHandle: null,
      sandboxPath,
      // Wake-ups that carry generated/annotated images embed them as
      // content blocks so the model can SEE the result on this turn
      // instead of having to Read the path first.
      images: job.attachImages && job.attachImages.length > 0 ? job.attachImages : undefined,
      // If this cron event is itself a relay envelope (set by
      // bridge/relay.ts), carry the depth forward so the receiving
      // session-bot can't relay back beyond MAX_RELAY_DEPTH.
      inboundDepth: parseInboundDepth(job.systemEvent),
      onHeartbeat,
    },
    config,
    state,
  );
  recordSpend(config.paths.data_dir, {
    sessionKey: job.sessionKey,
    subsystem: "cron",
    costUsd: result.ok ? (result.totalCostUsd ?? null) : null,
    durMs: Date.now() - started,
    contextTokens: result.ok ? (result.contextTokens ?? null) : null,
  });
  if (!result.ok) {
    log.error("cron", `fire failed ${kind}`, {
      job: job.id,
      dur: humanMs(Date.now() - started),
      err: snippet(result.error, 200),
    });
    if (isOperatorActionable(result.error)) {
      await alert.notify({
        category: "scheduled cron job failed",
        error: result.error,
        context: { job: job.id, session: job.sessionKey },
      });
    }
    if (isRetryable(result.error)) {
      scheduleRetry(job, crons);
    }
    return;
  }
  state.setClaudeSessionId(job.sessionKey, result.claudeSessionId);
  reanchorCodexIfNeeded(result, compactConfigFor("codex", config), state, job.sessionKey);

  // Tool-only handling: if the model handled the event entirely via mid-turn
  // tools (send_message, send_attachment, etc.) its final assistant text is
  // empty. That's not an error — the user already saw the output. Skip
  // deliverReply so we don't log a spurious "empty after sanitize" failure.
  if (!result.reply?.trim()) {
    log.info("cron", `fire ok ${kind} (tool-only)`, {
      job: job.id,
      dur: humanMs(Date.now() - started),
    });
    return;
  }

  const isGroup = isGroupSession(job.sessionKey);
  const delivery = await deliverReply(
    {
      to: isGroup ? chatGuid : chatIdFromKey(job.sessionKey),
      isGroup,
      text: result.reply,
      // Pin the exact chat row for DMs too (the turn path has always done
      // this): a bare handle leaves the pick to IMCore's registry, and a
      // poisoned entry routes the send to the note-to-self thread. Both of
      // today's misdelivered sends were cron deliveries missing this pin.
      chatGuid,
    },
    config,
    echoes,
  );

  if (delivery.errors.length > 0) {
    log.error("cron", `fire delivery errors ${kind}`, {
      job: job.id,
      errors: delivery.errors.join("; "),
    });
    // Recoverable failure (bridge wedge, misroute pending a registry heal):
    // stash the reply so the next inbound turn or the sweeper delivers it
    // once the bridge is healthy — the turn path has always done this, but
    // cron replies were simply dropped (two scheduled sends and a job-done
    // notice were lost this way during one bridge outage + heal cooldown).
    // Permanent (content) errors stay drop-and-log: the same text would
    // fail forever. Never clobber an existing stash — an earlier undelivered
    // reply is not superseded by an unrelated cron's reply.
    if (
      delivery.sent === 0 &&
      !delivery.errors.every((e) => isPermanentSendError(e)) &&
      state.getOutbox(job.sessionKey) === null
    ) {
      state.putOutbox({
        sessionKey: job.sessionKey,
        replyText: result.reply,
        chatGuid,
        isGroup: isGroup ? 1 : 0,
        service: "iMessage",
        nowMs: Date.now(),
      });
      state.recordError(job.sessionKey, "send_failed", Date.now());
      log.warn("cron", `stashed undelivered ${kind} reply to outbox`, {
        job: job.id,
        session: job.sessionKey,
        chars: result.reply.length,
      });
    }
  } else if (delivery.silenced) {
    // Model produced a reply that the outbound sanitizer recognized as a
    // silence-intent statement ("Silent, nothing owed", etc.) and dropped.
    // For recovery / poke wake-ups that's the correct outcome — the model
    // checked, decided no reply was needed, no-oped. Not a delivery error.
    log.info("cron", `fire ok ${kind} (silenced)`, {
      job: job.id,
      dur: humanMs(Date.now() - started),
    });
  } else {
    log.info("cron", `fire ok ${kind}`, {
      job: job.id,
      chunks: delivery.sent,
      dur: humanMs(Date.now() - started),
    });
  }
}

function classifyEvent(systemEvent: string): string {
  if (systemEvent.startsWith("Self-poke:")) return "poke";
  if (systemEvent.startsWith("[Retry")) return "retry";
  if (systemEvent.startsWith("A sub-agent you spawned")) return "agent-done";
  if (systemEvent.startsWith("An agent team has finished")) return "team-done";
  if (systemEvent.startsWith("Background tool job")) return "bg-job-done";
  if (systemEvent.startsWith("[System recovery check")) return "recovery";
  return "scheduled";
}

function scheduleRetry(job: CronJob, crons: CronStore): void {
  const { attempt, base } = parseRetryMeta(job.systemEvent);
  const next = attempt + 1;
  if (next > MAX_RETRIES) {
    log.error("cron", "retries exhausted — giving up", {
      job: job.id,
      max: MAX_RETRIES,
    });
    return;
  }
  const retryEvent = `[Retry ${next}/${MAX_RETRIES}] ${base}`;
  try {
    const retryJob = crons.create({
      sessionKey: job.sessionKey,
      systemEvent: retryEvent,
      schedule: { kind: "once", atMs: Date.now() + RETRY_DELAY_MS },
    });
    log.info("cron", "retry scheduled", {
      parent: job.id,
      retry_id: retryJob.id,
      attempt: `${next}/${MAX_RETRIES}`,
      at: new Date(retryJob.nextFireMs).toISOString(),
    });
  } catch (err) {
    log.error("cron", "failed to schedule retry", {
      job: job.id,
      err: snippet(String(err), 200),
    });
  }
}

/**
 * Extract the retry-attempt counter if the event is already a retry, so we
 * can cap the chain at MAX_RETRIES. For a fresh (non-retry) event, attempt
 * is 0 and base is the event verbatim.
 */
function parseRetryMeta(systemEvent: string): { attempt: number; base: string } {
  const m = systemEvent.match(/^\[Retry (\d+)\/\d+\]\s+([\s\S]*)$/);
  if (!m || !m[1] || !m[2]) return { attempt: 0, base: systemEvent };
  return { attempt: Number.parseInt(m[1], 10), base: m[2] };
}
