import {
  type OperatorAlert,
  isAuthFailure,
  isOperatorActionable,
  isRetryable,
} from "../alerts/operator-alert.ts";
import { parseInboundDepth } from "../bridge/relay.ts";
import { deliverReply } from "../channels/deliver.ts";
import { injectIntoRunningTurnAndConfirm } from "../claude/runner.ts";
import type { Config } from "../config/config.ts";
import type { GhostPrefsStore } from "../ghost/prefs.ts";
import type { ChatDb } from "../imessage/db.ts";
import { isPermanentSendError } from "../imessage/send.ts";
import { compactConfigFor, reanchorCodexIfNeeded, runModel } from "../model/runner.ts";
import { ensureSandbox } from "../persona/sandbox.ts";
import { fireBrownNose } from "../proactive/fire.ts";
import { isBrownNoseEvent } from "../proactive/queue.ts";
import type { EchoCache } from "../sessions/echo-cache.ts";
import { chatIdFromKey, isGroupSession } from "../sessions/key.ts";
import type { SessionLocks } from "../sessions/locks.ts";
import type { StateStore } from "../sessions/store.ts";
import { recordSpend, resumedRunSpend } from "../spend/ledger.ts";
import { envelopeStamp } from "../util/clock.ts";
import { humanMs, log, snippet } from "../util/log.ts";
import { fireReceptions, receptionBlock } from "./reception.ts";
import { inboundRetryAlreadyAnswered } from "./retry-marker.ts";
import type { CronStore } from "./store.ts";
import type { CronJob } from "./types.ts";
import { type RecentThread, wakeThreadBlock } from "./wake-thread.ts";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
/** An expired login lasts until a human logs in again: 63 minutes on
 *  2026-10-23, about 15 hours on 08-25. Three retries five minutes apart gave
 *  up after a quarter of an hour, and 33 scheduled jobs were lost that way.
 *  Doubling from five minutes to a two-hour ceiling covers about 8.5 hours. */
const AUTH_MAX_RETRIES = 8;
const AUTH_RETRY_CEILING_MS = 2 * 60 * 60 * 1000;

/** How many retries a failure gets and how long to wait before this one. */
export function retryPlan(attempt: number, error: string): { max: number; delayMs: number } {
  if (!isAuthFailure(error)) return { max: MAX_RETRIES, delayMs: RETRY_DELAY_MS };
  return {
    max: AUTH_MAX_RETRIES,
    delayMs: Math.min(RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1), AUTH_RETRY_CEILING_MS),
  };
}

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
  recentThread: RecentThread,
  opts: {
    /** Show a finished result to the session's running turn; true once it joined. */
    showToRunningTurn?: (sessionKey: string, text: string) => Promise<boolean>;
    /** chat.db, so a recurring job can see how its last sends landed. */
    chatDb?: ChatDb;
  } = {},
): Promise<void> {
  const showToRunningTurn = opts.showToRunningTurn ?? injectIntoRunningTurnAndConfirm;
  // A finished result for a chat whose turn is still running joins that turn
  // at its next tool step instead of waiting for the lock: sub-agent results
  // waited a p90 of 49 minutes and background-job results 28 behind turns
  // that were already running in the same chat (30 days to 2026-10-25). If it
  // cannot join (no turn, no tool step, the turn ended first), it fires as
  // its own turn exactly as before.
  if (isResultWakeUp(job.systemEvent)) {
    const joined = await showToRunningTurn(job.sessionKey, resultNote(job.systemEvent)).catch(
      () => false,
    );
    if (joined) {
      log.info("cron", "result joined the running turn", {
        job: job.id,
        session: job.sessionKey,
        kind: classifyEvent(job.systemEvent),
      });
      return;
    }
  }

  // Brown-nose route: cron rows enqueued by the ghost have a tagged
  // systemEvent. They use a different envelope shape (no "scheduled
  // event" framing), recheck budgets, and respect the global
  // concurrency semaphore.
  if (isBrownNoseEvent(job.systemEvent)) {
    await locks.withLock(job.sessionKey, async () => {
      await fireBrownNose(
        job,
        config,
        state,
        echoes,
        crons,
        ghostPrefs,
        () => locks.touch(job.sessionKey),
        recentThread,
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
    await runAndDeliver(
      job,
      config,
      state,
      echoes,
      alert,
      crons,
      session.chatGuid,
      () => locks.touch(job.sessionKey),
      recentThread,
      opts.chatDb,
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
  onHeartbeat: (() => void) | undefined,
  recentThread: RecentThread,
  chatDb?: ChatDb,
): Promise<void> {
  const now = Date.now();
  const latenessMs = now - job.nextFireMs;
  const latenessNote = latenessMs > 90_000 ? ` · ${Math.round(latenessMs / 60_000)}m late` : "";
  const thread = wakeThreadBlock(job.sessionKey, chatGuid, config, state, recentThread);
  const kind = classifyEvent(job.systemEvent);
  // A recurring job sees how its last sends landed (cron/reception.ts).
  const recurring = job.schedule.kind !== "once" && kind === "scheduled";
  let reception: string | null = null;
  if (recurring && chatDb) {
    try {
      reception = receptionBlock(
        fireReceptions(chatDb, chatGuid, crons.recentFireWindows(job.id, 6), now),
      );
    } catch (err) {
      log.warn("cron", "reception lookup failed", { job: job.id, err: (err as Error).message });
    }
  }
  const envelope = [
    scheduledEventHeader(job.nextFireMs, now, latenessNote),
    "",
    job.systemEvent,
    ...(reception ? ["", reception] : []),
    ...(thread ? ["", thread] : []),
  ].join("\n");

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
      cronJob: job.id,
      onHeartbeat,
    },
    config,
    state,
  );
  recordSpend(config.paths.data_dir, {
    sessionKey: job.sessionKey,
    subsystem: "cron",
    ...resumedRunSpend(result),
    durMs: Date.now() - started,
    contextTokens: result.ok ? (result.contextTokens ?? null) : null,
  });
  if (recurring && result.ok) {
    try {
      crons.recordFireWindow(job.id, job.sessionKey, started, Date.now());
    } catch {}
  }
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
      scheduleRetry(job, crons, result.error);
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
      // A wake-up landing while the conversation is on a call (an agent's
      // result, a reminder) is spoken to the person on the call.
      sessionKey: job.sessionKey,
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

/** Wake-ups that carry a finished result: worth showing to a running turn. */
export function isResultWakeUp(systemEvent: string): boolean {
  const kind = classifyEvent(systemEvent);
  return kind === "agent-done" || kind === "team-done" || kind === "bg-job-done";
}

/** How a finished result is shown to a turn that is still running. */
export function resultNote(systemEvent: string): string {
  return [
    "[SYSTEM — a background result arrived while you're working]",
    systemEvent,
    "",
    "If the person is waiting on this, tell them with send_message before your next tool call, then carry on with your current task. It will not be shown to you again when this turn ends.",
  ].join("\n");
}

function classifyEvent(systemEvent: string): string {
  if (systemEvent.startsWith("Self-poke:")) return "poke";
  if (systemEvent.startsWith("[Retry")) return "retry";
  if (systemEvent.startsWith("A sub-agent you spawned")) return "agent-done";
  if (systemEvent.startsWith("An agent team has finished")) return "team-done";
  if (systemEvent.startsWith("Several sub-agent results arrived together")) return "agent-done";
  if (systemEvent.startsWith("Background tool job")) return "bg-job-done";
  if (systemEvent.startsWith("[System recovery check")) return "recovery";
  return "scheduled";
}

export function scheduleRetry(job: CronJob, crons: CronStore, error = ""): void {
  const { attempt, base } = parseRetryMeta(job.systemEvent);
  const next = attempt + 1;
  const plan = retryPlan(next, error);
  if (next > plan.max) {
    log.error("cron", "retries exhausted — giving up", {
      job: job.id,
      max: plan.max,
    });
    return;
  }
  const retryEvent = `[Retry ${next}/${plan.max}] ${base}`;
  try {
    const retryJob = crons.create({
      sessionKey: job.sessionKey,
      systemEvent: retryEvent,
      schedule: { kind: "once", atMs: Date.now() + plan.delayMs },
      // The same text under a retry prefix, so it keeps its author.
      harnessWritten: job.harnessWritten,
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

/**
 * The first line of a scheduled event's envelope. Times are in the home zone,
 * stamped like every inbound message: they were UTC ISO, so a reminder firing
 * after 8pm Eastern (16% of fires) carried tomorrow's date beside a model that
 * reads every other time in Eastern.
 */
export function scheduledEventHeader(
  scheduledMs: number,
  firedMs: number,
  latenessNote: string,
): string {
  return `[Scheduled event · scheduled=${envelopeStamp(new Date(scheduledMs))} fired=${envelopeStamp(new Date(firedMs))}${latenessNote}]`;
}
