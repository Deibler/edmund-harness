import type { Config } from "../config/config.ts";
import type { CronStore } from "../cron/store.ts";
import { nextActiveStartMs } from "../ghost/budget.ts";
import type { BrownNosePrefs } from "../ghost/prefs.ts";
import type { GhostDecision } from "../ghost/think.ts";
import type { SessionKey } from "../sessions/key.ts";
import { log } from "../util/log.ts";

/**
 * Enqueue ghost decisions as cron rows the existing scheduler picks up.
 *
 * Encoding: the cron `systemEvent` field carries a `[BROWN_NOSE]<json>`
 * payload. The cron fire handler in `src/cron/fire.ts` detects the
 * prefix and routes to `src/proactive/fire.ts` instead of the standard
 * scheduled-event envelope flow. JSON keeps the brief, tags, ghost
 * decision metadata, and expiry all in one place without needing a new
 * column on the jobs table.
 *
 * Schedule jitter is applied here at enqueue time — the ghost picks a
 * desired fireAtMs and we add a uniformly-random offset from the
 * config window. Without jitter, multiple sessions whose ghosts pick
 * the same "obvious" time (Fri 4pm, Sun 10am) would converge into a
 * cluster at fire time.
 */

export const BROWN_NOSE_PREFIX = "[BROWN_NOSE]";

/** Decoded payload stored on the cron row. */
export type BrownNoseCronPayload = {
  brief: string;
  tags: string[];
  contextFiles?: string[];
  /** When this brief is stale and should be dropped at fire time. */
  expiresAtMs: number;
  /** Tick that produced this decision (links back to decisions.jsonl). */
  ghostTickAtMs: number;
  /** confidence reported by ghost. */
  confidence: "low" | "medium" | "high";
};

export type EnqueueResult =
  | { enqueued: true; jobId: string; jitteredFireAtMs: number }
  | { enqueued: false; reason: string };

/**
 * Hard floor between brown-nose fires for one chat. Once a fire is set in
 * stone, the next one — however it was triggered, forced ticks included —
 * must land at least this far after it. Operator rule: proactive contact
 * that clusters tighter than two days reads as a feed, not a friend.
 */
const MIN_FIRE_SPACING_MS = 48 * 3_600_000;

/**
 * Encode + insert. Caller is the observer (after ghost says act:true)
 * or the CLI (`--invoke --fire-now`). The cron scheduler will pick the
 * row up when nextFireMs arrives.
 */
export function enqueueBrownNoseFire(args: {
  sessionKey: SessionKey;
  decision: GhostDecision & { act: true };
  config: Config;
  crons: CronStore;
  /** Session prefs — used to clamp the fire time into active hours.
   *  Optional only for callers that genuinely have no prefs (tests, CLI
   *  fire-now); when present, an out-of-window fire time is moved to the
   *  next window opening instead of being dropped at fire time. */
  sessionPrefs?: Pick<BrownNosePrefs, "activeHours" | "timezone"> | null;
  /** Most-recent-fire lookup — when provided, the 48h hard-spacing rule
   *  is enforced against the last fire that actually invoked the main
   *  model. Shape matches GhostPrefsStore.recentFires. */
  prefsStore?: {
    recentFires: (sessionKey: SessionKey, limit: number) => Array<{ firedAtMs: number }>;
  } | null;
  /** Set to true by `--fire-now` to skip jitter. */
  noJitter?: boolean;
}): EnqueueResult {
  const cfg = args.config.brown_nose;

  // HARD RULE 1 — one queued brown-nose per chat, ever. A second queued
  // fire would either stack on the first or land inside its 48h shadow;
  // neither is allowed once a fire is set in stone.
  const pending = args.crons
    .listActive(args.sessionKey)
    .filter((j) => isBrownNoseEvent(j.systemEvent));
  if (pending.length > 0) {
    const p = pending[0]!;
    return {
      enqueued: false,
      reason: `another brown-nose fire is already queued for this chat (${p.id}, fires ${new Date(p.nextFireMs).toISOString()}) — one at a time, ${MIN_FIRE_SPACING_MS / 3_600_000}h apart minimum`,
    };
  }

  const jitterMs = args.noJitter
    ? 0
    : randomMinutes(cfg.schedule_jitter_min_minutes, cfg.schedule_jitter_max_minutes);
  let jitteredFireAtMs = args.decision.fireAtMs + jitterMs;

  // Active-hours clamp. The ghost is told the window but sometimes picks
  // a moment just outside it ("tomorrow 8am" against a 9am open) — and the
  // fire-time budget gate would then drop the job entirely, which is how
  // the first organic fire ever queued died. Move it to the window opening
  // instead; the jitter already applied keeps multiple sessions from all
  // landing exactly at the open.
  const windowClamp = (t: number): number => {
    if (!args.sessionPrefs) return t;
    const inWindow = nextActiveStartMs(args.sessionPrefs, t);
    return inWindow !== null && inWindow !== t ? inWindow + jitterMs : t;
  };
  jitteredFireAtMs = windowClamp(jitteredFireAtMs);

  // HARD RULE 2 — at least 48h after the last fire that actually went
  // out. Push the new fire to the floor (re-clamped into a window); if
  // the brief expires before the floor, it doesn't get to exist.
  if (args.prefsStore) {
    const last = args.prefsStore.recentFires(args.sessionKey, 1)[0];
    if (last) {
      const floorMs = last.firedAtMs + MIN_FIRE_SPACING_MS;
      if (jitteredFireAtMs < floorMs) {
        const pushed = windowClamp(floorMs + jitterMs);
        if (pushed >= args.decision.expiresAtMs) {
          return {
            enqueued: false,
            reason: `48h spacing: last fire was ${new Date(last.firedAtMs).toISOString()}, earliest allowed ${new Date(floorMs).toISOString()}, but the brief expires ${new Date(args.decision.expiresAtMs).toISOString()} before then`,
          };
        }
        log.info("brown-nose-queue", "pushed for 48h spacing", {
          session: args.sessionKey,
          requested: new Date(jitteredFireAtMs).toISOString(),
          pushed_to: new Date(pushed).toISOString(),
        });
        jitteredFireAtMs = pushed;
      }
    }
  }

  // Don't let jitter push past expiry — that would result in a fired
  // job that immediately drops itself. Clamp.
  const finalFireAtMs = Math.min(jitteredFireAtMs, args.decision.expiresAtMs - 1);
  if (finalFireAtMs <= Date.now() - 1000) {
    return {
      enqueued: false,
      reason: `expired (fireAtMs=${args.decision.fireAtMs} + jitter=${jitterMs}ms expired vs ${args.decision.expiresAtMs})`,
    };
  }

  const payload: BrownNoseCronPayload = {
    brief: args.decision.brief,
    tags: args.decision.tags,
    contextFiles: args.decision.contextFiles,
    expiresAtMs: args.decision.expiresAtMs,
    ghostTickAtMs: args.decision.tickAtMs,
    confidence: args.decision.confidence,
  };
  const systemEvent = `${BROWN_NOSE_PREFIX}${JSON.stringify(payload)}`;
  const job = args.crons.create({
    sessionKey: args.sessionKey,
    systemEvent,
    schedule: { kind: "once", atMs: finalFireAtMs },
    // Grace period: the brief's own expiresAtMs is the real cutoff, but
    // cron grace is a coarse backstop. Use a generous default — most
    // briefs expire within hours anyway.
    gracePeriodMs: 12 * 3_600_000,
  });
  log.info("brown-nose-queue", "enqueued", {
    job: job.id,
    session: args.sessionKey,
    fire_at: new Date(finalFireAtMs).toISOString(),
    jitter_ms: jitterMs,
    tags: args.decision.tags,
    confidence: args.decision.confidence,
  });
  return { enqueued: true, jobId: job.id, jitteredFireAtMs: finalFireAtMs };
}

/** Strip the prefix and JSON-parse the payload. Returns null on any
 *  malformed input — caller falls back to standard envelope. */
export function decodeBrownNoseSystemEvent(systemEvent: string): BrownNoseCronPayload | null {
  if (!systemEvent.startsWith(BROWN_NOSE_PREFIX)) return null;
  const slice = systemEvent.slice(BROWN_NOSE_PREFIX.length);
  try {
    const raw = JSON.parse(slice) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    const brief = typeof obj.brief === "string" ? obj.brief : null;
    const tags = Array.isArray(obj.tags)
      ? obj.tags.filter((t): t is string => typeof t === "string")
      : [];
    const expiresAtMs = typeof obj.expiresAtMs === "number" ? obj.expiresAtMs : null;
    const ghostTickAtMs = typeof obj.ghostTickAtMs === "number" ? obj.ghostTickAtMs : null;
    const confidence =
      obj.confidence === "low" || obj.confidence === "medium" || obj.confidence === "high"
        ? obj.confidence
        : "low";
    const contextFiles = Array.isArray(obj.contextFiles)
      ? obj.contextFiles.filter((f): f is string => typeof f === "string")
      : undefined;
    if (!brief || expiresAtMs === null || ghostTickAtMs === null) return null;
    return { brief, tags, expiresAtMs, ghostTickAtMs, confidence, contextFiles };
  } catch {
    return null;
  }
}

/** True if a cron job's systemEvent is a brown-nose fire. */
export function isBrownNoseEvent(systemEvent: string): boolean {
  return systemEvent.startsWith(BROWN_NOSE_PREFIX);
}

function randomMinutes(min: number, max: number): number {
  if (max <= min) return min * 60_000;
  const minutes = min + Math.random() * (max - min);
  return Math.round(minutes * 60_000);
}
