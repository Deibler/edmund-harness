import { deliverReply } from "../channels/deliver.ts";
import { buildProactiveEnvelope } from "../channels/envelope.ts";
import { isKeepQuiet } from "../channels/sanitize-outbound.ts";
import type { Config } from "../config/config.ts";
import { nextFire } from "../cron/next-fire.ts";
import type { CronStore } from "../cron/store.ts";
import type { CronJob } from "../cron/types.ts";
import {
  checkActiveHours,
  checkEnabled,
  checkOutstandingFire,
  checkWeeklyCap,
  nextActiveStartMs,
} from "../ghost/budget.ts";
import { resolveIntensity } from "../ghost/intensity.ts";
import type { GhostPrefsStore } from "../ghost/prefs.ts";
import { compactConfigFor, reanchorCodexIfNeeded, runModel } from "../model/runner.ts";
import { ensureSandbox } from "../persona/sandbox.ts";
import { loadPortalSecret, portalUrl } from "../portal/token.ts";
import type { EchoCache } from "../sessions/echo-cache.ts";
import { type SessionKey, chatIdFromKey, isGroupSession } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { recordSpend } from "../spend/ledger.ts";
import { humanMs, log, snippet } from "../util/log.ts";
import { decodeBrownNoseSystemEvent } from "./queue.ts";
import { getSemaphore } from "./semaphore.ts";

/**
 * Brown-nose fire handler.
 *
 * Called from `src/cron/fire.ts` when a cron row's systemEvent has the
 * `[BROWN_NOSE]` prefix. Order of operations:
 *
 *   1. Decode the payload. Malformed → drop silently (the prefix is
 *      tamper-evident; bad rows are bugs, not normal).
 *   2. Check expiry. If `now > expiresAtMs`, drop with a log line.
 *   3. Re-check budgets: prefs.enabled (could have been flipped off),
 *      active hours, weekly cap. Cooldown is skipped — the ghost
 *      already enforced it at schedule time, and a deferred fire
 *      shouldn't re-fight cooldown against itself.
 *   4. Acquire the global semaphore. If cap is full or stagger says
 *      "too soon," defer the cron row by `fire_defer_*` minutes and
 *      bail. The cron scheduler re-fires when the new time arrives.
 *   5. Build a proactive_opportunity envelope with the brief +
 *      context files + intensity-aware decision rubric.
 *   6. Invoke main via runClaude (same pool, same tools, same
 *      persona — just with the synthetic envelope).
 *   7. Record the fire to `brown_nose_fires` for engagement tracking.
 *   8. If the model produced text (NOT `KEEP_QUIET`), deliver via
 *      the normal channel. Empty / `KEEP_QUIET` reply = silent veto.
 *   9. Release the semaphore.
 *
 * The KEEP_QUIET signal is the model's final veto. The persona
 * (VENUE_DM.md / VENUE_GROUP.md) is taught to respond with exactly
 * `KEEP_QUIET` when the moment has shifted. We treat that text as
 * "do not send" — same as the existing outbound sanitizer's silence
 * intent handling.
 */

export async function fireBrownNose(
  job: CronJob,
  config: Config,
  state: StateStore,
  echoes: EchoCache,
  crons: CronStore,
  prefs: GhostPrefsStore,
  onHeartbeat?: () => void,
): Promise<void> {
  const payload = decodeBrownNoseSystemEvent(job.systemEvent);
  if (!payload) {
    log.warn("brown-nose-fire", "decode failed, dropping", { job: job.id });
    return;
  }
  const sessionKey = job.sessionKey as SessionKey;

  // 2. Expiry check
  const nowMs = Date.now();
  if (nowMs > payload.expiresAtMs) {
    log.info("brown-nose-fire", "expired, dropping", {
      job: job.id,
      session: sessionKey,
      expired_ago_min: Math.round((nowMs - payload.expiresAtMs) / 60_000),
    });
    return;
  }

  // 3. Re-check budgets. Cooldown deliberately skipped — see header.
  const sessionPrefs = prefs.get(sessionKey);
  if (!sessionPrefs) {
    log.warn("brown-nose-fire", "no prefs row, dropping", { job: job.id, session: sessionKey });
    return;
  }
  // Same effective-cap rule as the ghost tick: current intensity wins
  // over a stale per-row cap.
  sessionPrefs.weeklyCap = Math.max(
    sessionPrefs.weeklyCap,
    resolveIntensity(config.brown_nose.intensity).weeklyCap,
  );
  const recentFires = prefs.recentFires(sessionKey, 10);
  const weekAgo = nowMs - 7 * 24 * 3_600_000;
  const weekFires = recentFires.filter((f) => f.firedAtMs >= weekAgo);
  // Individual gates (cooldown deliberately skipped — see header), because
  // the right reaction differs per gate: enabled/cap failures are terminal
  // for this brief, but an active-hours miss just means "not right now" —
  // defer to the window opening instead of dropping. Dropping here is how
  // the only organic fire ever queued was lost (scheduled 8:07, window
  // opened 9:00).
  const enabledGate = checkEnabled(sessionPrefs, config.brown_nose.enabled);
  const capGate = checkWeeklyCap(sessionPrefs, weekFires);
  // One open proactive thread at a time, re-checked at fire time: a
  // SECOND queued brief must not deliver while the first sits unanswered.
  const session0 = state.getSession(sessionKey);
  const outstandingGate = checkOutstandingFire(recentFires, session0?.lastInboundMs ?? 0);
  for (const gate of [enabledGate, capGate, outstandingGate]) {
    if (!gate.ok) {
      log.info("brown-nose-fire", "budget rejected at fire time, dropping", {
        job: job.id,
        session: sessionKey,
        reason: gate.reason,
      });
      return;
    }
  }
  const hoursGate = checkActiveHours(sessionPrefs, nowMs);
  if (!hoursGate.ok) {
    const windowStart = nextActiveStartMs(sessionPrefs, nowMs);
    if (windowStart === null || windowStart >= payload.expiresAtMs) {
      log.info("brown-nose-fire", "outside active hours and brief expires first, dropping", {
        job: job.id,
        session: sessionKey,
        reason: hoursGate.reason,
      });
      return;
    }
    const revived = crons.deferMidFire(job.id, windowStart);
    log.info("brown-nose-fire", "outside active hours, deferred to window open", {
      job: job.id,
      session: sessionKey,
      new_fire_at: new Date(windowStart).toISOString(),
      revived,
    });
    return;
  }

  // 4. Concurrency + stagger
  const sem = getSemaphore();
  const acq = sem.tryAcquire(nowMs);
  if (!acq.acquired) {
    deferCronRow(crons, job, config, acq.reason);
    return;
  }

  try {
    await fireImpl(job, payload, config, state, echoes, prefs, sessionKey, onHeartbeat);
  } finally {
    acq.release();
  }
}

async function fireImpl(
  job: CronJob,
  payload: ReturnType<typeof decodeBrownNoseSystemEvent> & object,
  config: Config,
  state: StateStore,
  echoes: EchoCache,
  prefs: GhostPrefsStore,
  sessionKey: SessionKey,
  onHeartbeat?: () => void,
): Promise<void> {
  const session = state.getSession(sessionKey);
  if (!session) {
    log.warn("brown-nose-fire", "no session record", { job: job.id, session: sessionKey });
    return;
  }

  const sandboxPath = ensureSandbox(sessionKey, null);
  const tz = prefs.get(sessionKey)?.timezone ?? config.brown_nose.default_timezone;
  const localTimeLabel = formatLocal(Date.now(), tz);

  // Standing self-service link for the recipient — every proactive message
  // closes with a one-sentence explanation + this link so the user always
  // has a way to tune or kill the feature for themselves.
  let portalLink: string | undefined;
  try {
    portalLink = portalUrl(config, loadPortalSecret(config.paths.data_dir), sessionKey);
  } catch {
    portalLink = undefined; // no secret yet (dashboard never booted) — skip footer
  }

  const envelope = buildProactiveEnvelope({
    brief: payload.brief,
    contextFiles: payload.contextFiles,
    tags: payload.tags,
    localTimeLabel,
    portalUrl: portalLink,
  });

  const started = Date.now();
  log.info("brown-nose-fire", "firing", {
    job: job.id,
    session: sessionKey,
    tags: payload.tags,
    confidence: payload.confidence,
    brief: snippet(payload.brief, 120),
  });

  // 5+6. Record + invoke main
  const fireId = prefs.recordFire({
    sessionKey,
    firedAtMs: Date.now(),
    brief: payload.brief,
    tags: payload.tags,
  });

  const result = await runModel(
    {
      sessionKey,
      envelope,
      senderLabel: "ghost",
      senderHandle: null,
      sandboxPath,
      onHeartbeat,
    },
    config,
    state,
  );
  recordSpend(config.paths.data_dir, {
    sessionKey,
    subsystem: "ghost-fire",
    costUsd: result.ok ? (result.totalCostUsd ?? null) : null,
    durMs: Date.now() - started,
    contextTokens: result.ok ? (result.contextTokens ?? null) : null,
  });

  if (!result.ok) {
    log.error("brown-nose-fire", "main run failed", {
      job: job.id,
      session: sessionKey,
      dur: humanMs(Date.now() - started),
      err: snippet(result.error, 200),
    });
    // Don't retry brown-nose fires — they're unprompted; if main can't
    // run right now, the user isn't waiting on anything. Stamp `error`,
    // not `ignored`: infrastructure failure must not decay the session's
    // cooldown as if the user snubbed a message they never received.
    prefs.recordOutcome(fireId, "error");
    return;
  }
  state.setClaudeSessionId(sessionKey, result.claudeSessionId);
  reanchorCodexIfNeeded(result, compactConfigFor("codex", config), state, sessionKey);

  // KEEP_QUIET veto: main read the brief, decided context has shifted,
  // and declined to act. That's the system working — log + done.
  const reply = result.reply?.trim() ?? "";
  if (reply.length === 0 || isKeepQuiet(reply)) {
    log.info("brown-nose-fire", "main vetoed (KEEP_QUIET)", {
      job: job.id,
      session: sessionKey,
      dur: humanMs(Date.now() - started),
    });
    // Stamp `vetoed` explicitly. Leaving outcome NULL here was the
    // 2026-07-28 corruption: the sweep selects `outcome IS NULL` and
    // stamped engaged/ignored from user messages that were reactions to
    // nothing — 10/35 of all outcomes were phantom. A stamped veto also
    // releases the one-open-thread gate immediately (nothing is
    // outstanding; no message exists to be answered).
    prefs.recordOutcome(fireId, "vetoed");
    return;
  }

  // Deliver normally. The outbound sanitizer + chunker run as usual.
  const isGroup = isGroupSession(sessionKey);
  const delivery = await deliverReply(
    {
      to: isGroup ? session.chatGuid : chatIdFromKey(sessionKey),
      isGroup,
      text: reply,
      // Pin the exact chat row for DMs too. A bare handle leaves the pick to
      // IMCore's registry, which resolves it to the note-to-self thread and
      // gets the send refused (chat_mismatch). cron/fire.ts and the turn path
      // already pin; this path was missed.
      chatGuid: session.chatGuid,
    },
    config,
    echoes,
  );

  if (delivery.sent > 0) {
    // At least one chunk reached the user — the fire is now scoreable
    // from their behavior.
    prefs.markDelivered(fireId);
    // Count delivered fires against any matching focus-topic weekly cap.
    prefs.recordFocusUsage(sessionKey, payload.tags);
  } else {
    prefs.recordOutcome(fireId, "error");
  }
  if (delivery.errors.length > 0) {
    log.error("brown-nose-fire", "delivery errors", {
      job: job.id,
      sent: delivery.sent,
      errors: delivery.errors.join("; "),
    });
  } else {
    log.info("brown-nose-fire", "delivered", {
      job: job.id,
      session: sessionKey,
      chunks: delivery.sent,
      dur: humanMs(Date.now() - started),
    });
  }
}

/**
 * Concurrency / stagger said no. Push the cron row forward by a
 * uniformly-random offset in `[fire_defer_min, fire_defer_max]`
 * minutes. The scheduler will re-fire when the new time arrives;
 * `tryAcquire` will be re-attempted.
 */
function deferCronRow(crons: CronStore, job: CronJob, config: Config, reason: string): void {
  const cfg = config.brown_nose;
  const offsetMs = randomMinutes(cfg.fire_defer_min_minutes, cfg.fire_defer_max_minutes);
  const newFireAtMs = Date.now() + offsetMs;
  // Reuse existing once-shot schedule shape so nextFire() handles it.
  const next = nextFire({ kind: "once", atMs: newFireAtMs }, Date.now());
  if (next === null) {
    log.warn("brown-nose-fire", "defer: nextFire returned null, dropping", { job: job.id });
    return;
  }
  // deferMidFire, not bumpNextFire: the scheduler already marked this
  // once-job `done` before invoking us, so a plain active-only bump would
  // silently no-op and the brief would be lost.
  const revived = crons.deferMidFire(job.id, next);
  log.info("brown-nose-fire", "deferred", {
    job: job.id,
    reason,
    new_fire_at: new Date(next).toISOString(),
    offset_min: Math.round(offsetMs / 60_000),
    revived,
  });
}

function randomMinutes(min: number, max: number): number {
  if (max <= min) return min * 60_000;
  const minutes = min + Math.random() * (max - min);
  return Math.round(minutes * 60_000);
}

function formatLocal(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}
