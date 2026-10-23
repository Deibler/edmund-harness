import type { Config } from "../config/config.ts";
import type { CronStore } from "../cron/store.ts";
import type { ChatDb } from "../imessage/db.ts";
import { enqueueBrownNoseFire } from "../proactive/queue.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import type { SessionKey } from "../sessions/key.ts";
import { isGroupSession } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { getSpendLedger, localDay } from "../spend/ledger.ts";
import { log } from "../util/log.ts";
import { isContact } from "./budget.ts";
import { resolveIntensity } from "./intensity.ts";
import { withLandingEvidence } from "./landed.ts";
import {
  type SessionActivity,
  type TickReason,
  pickNextSession,
  windowOpenedAtMs,
} from "./picker.ts";
import {
  DEFAULT_ACTIVE_HOURS_DM,
  DEFAULT_ACTIVE_HOURS_GROUP,
  type GhostPrefsStore,
} from "./prefs.ts";
import {
  type GhostDecision,
  type GhostSmsHistory,
  lastMessageAtMs,
  lastTickTimes,
  recordDecisionNote,
  runGhostTick,
} from "./think.ts";

/**
 * Ghost observer — runs periodic + event-driven ghost ticks.
 *
 * Event triggers (Phase 4):
 *
 *   - **onMainReplied** — explicit method called from the daemon's
 *     `sendDeliver` path. A just-finished exchange is a good moment for
 *     the ghost to plant a future hook, but only once it HAS finished:
 *     the tick waits until the chat has been quiet for SETTLE_MS (the
 *     episode gap), re-arming while it isn't. It used to fire 60-120s
 *     after every reply: 288 of 394 ticks in 2026-10-09..23 landed
 *     within 2.5 minutes of Edmund's own message, and the pre-screen
 *     declined nearly all of them as mid-conversation.
 *
 *   - **window_start** — picker priority 1. When a session's active
 *     hours just opened (within the last 30 min), the next sweep tick
 *     picks that session preferentially. "Morning of the user's day."
 *
 *   - **quiet_24h / quiet_4h** — picker priorities 2 and 3. When a
 *     user has been silent past a threshold without a tick covering
 *     that stretch yet, the picker prefers them. "User probably done
 *     for now / would have responded by now."
 *
 *   - **sweep** — picker priority 4 backstop. Round-robin oldest tick
 *     wins. Same behavior as Phase 2.
 *
 * Ghost decisions still flow to the cron queue exactly as in Phase 3.
 */

/** Floor between ghost ticks for one session, any trigger path. Mirrors
 *  the picker's default so reactive (post-reply) ticks can't stack. */
const MIN_TICK_SPACING_MS = 45 * 60_000;
/** A chat quiet this long has finished its exchange: the same 30-minute
 *  gap that splits conversation episodes for the ghost's history. */
export const SETTLE_MS = 30 * 60_000;
/** Spread on top of SETTLE_MS so settled ticks don't land on a rhythm. */
const SETTLE_JITTER_MS = 30 * 60_000;

/** How much longer until a chat quiet for `quietMs` counts as settled. */
export function settleRemainingMs(quietMs: number): number {
  return Math.max(0, SETTLE_MS - quietMs);
}

const TICK_REASONS: readonly TickReason[] = [
  "window_start",
  "quiet_4h",
  "quiet_24h",
  "sweep",
  "settled",
];

export class GhostObserver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAtMs = new Map<SessionKey, number>();
  private lastTickByReason = new Map<string, Map<TickReason, number>>();
  /** Pending post-reply ticks. Maps sessionKey → timer handle so a
   *  second reply in quick succession resets the delay rather than
   *  scheduling parallel ticks. */
  private pendingReplyTicks = new Map<SessionKey, ReturnType<typeof setTimeout>>();
  /** Last reply seen per session, alongside the session store's times. */
  private lastReplyAtMs = new Map<SessionKey, number>();
  private stopped = false;

  constructor(
    private readonly deps: {
      config: Config;
      chatDb: ChatDb;
      contacts: ContactBook;
      prefs: GhostPrefsStore;
      crons: CronStore;
      state: StateStore;
      /** Extra per-session exclusion (beyond the trading:/orch: namespaces).
       *  Wired by main.ts to keep guest/vouched DM handles out of proactive
       *  outreach entirely — they are never ghost targets, never enrolled. */
      isExcludedSession?: (sessionKey: SessionKey) => boolean;
      /** SMS transcript reader for runGhostTick (see GhostDeps.sms). */
      sms?: GhostSmsHistory;
    },
  ) {}

  start(): void {
    if (!this.deps.config.brown_nose.enabled) {
      log.info("ghost-observer", "disabled by config — not starting");
      return;
    }
    log.info("ghost-observer", "starting", {
      intensity: this.deps.config.brown_nose.intensity,
    });
    this.seedTickHistory();
    this.scheduleNext();
  }

  /** Recover when each chat was last ticked from its decision log. */
  seedTickHistory(): void {
    for (const p of this.deps.prefs.list()) {
      const key = p.sessionKey as SessionKey;
      if (this.lastTickAtMs.has(key)) continue;
      const seen = lastTickTimes(key);
      if (seen.any > 0) this.lastTickAtMs.set(key, seen.any);
      const perReason = new Map<TickReason, number>();
      for (const r of TICK_REASONS) {
        const at = seen.byTrigger.get(r);
        if (at) perReason.set(r, at);
      }
      if (perReason.size > 0) this.lastTickByReason.set(key, perReason);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const t of this.pendingReplyTicks.values()) clearTimeout(t);
    this.pendingReplyTicks.clear();
  }

  /** Forcibly tick now for a specific session. Used by CLI --invoke. */
  async tickNow(
    sessionKey: SessionKey,
    opts: { bypassActiveHours?: boolean; bypassBudgets?: boolean },
  ): Promise<GhostDecision> {
    this.recordTick(sessionKey, "sweep");
    const decision = await runGhostTick(
      {
        sessionKey,
        bypassActiveHours: opts.bypassActiveHours,
        bypassBudgets: opts.bypassBudgets,
        trigger: "operator",
      },
      this.deps,
    );
    this.applySnooze(sessionKey, decision);
    this.maybeEnqueue(sessionKey, decision);
    return decision;
  }

  /**
   * Called from the daemon's sendDeliver path. Schedules a ghost tick for
   * when the exchange has settled (SETTLE_MS of quiet, plus jitter). Each
   * reply resets it; a timer that finds the chat still moving re-arms.
   */
  onMainReplied(sessionKey: SessionKey): void {
    if (!this.deps.config.brown_nose.enabled || this.stopped) return;
    this.lastReplyAtMs.set(sessionKey, Date.now());
    this.armSettledTick(sessionKey, SETTLE_MS + Math.floor(Math.random() * SETTLE_JITTER_MS));
  }

  /** Milliseconds since anything moved in this chat, either direction:
   *  the chat's own newest message (group chatter Edmund wasn't addressed
   *  in included), the session's turn times and the last reply seen. */
  quietForMs(sessionKey: SessionKey, nowMs: number): number {
    const s = this.deps.state.getSession(sessionKey);
    const last = Math.max(
      lastMessageAtMs(sessionKey, this.deps) ?? 0,
      s?.lastInboundMs ?? 0,
      s?.lastOutboundMs ?? 0,
      this.lastReplyAtMs.get(sessionKey) ?? 0,
    );
    return nowMs - last;
  }

  private armSettledTick(sessionKey: SessionKey, delayMs: number): void {
    const existing = this.pendingReplyTicks.get(sessionKey);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.pendingReplyTicks.delete(sessionKey);
      if (this.stopped) return;
      const remaining = settleRemainingMs(this.quietForMs(sessionKey, Date.now()));
      if (remaining > 0) {
        // Still a live conversation the main turn is handling.
        this.armSettledTick(sessionKey, remaining + Math.floor(Math.random() * 60_000));
        return;
      }
      // Skip the post-reply tick if the session isn't currently within
      // its active hours — it'd just produce a "outside active hours"
      // decision-log entry and waste a Haiku call slot.
      const sessionPrefs = this.ensureEnrolled(sessionKey);
      if (sessionPrefs && windowOpenedAtMs(sessionPrefs, Date.now()) === null) {
        log.debug?.("ghost-observer", "skipping reactive tick — outside active hours", {
          session: sessionKey,
        });
        return;
      }
      void this.runReactiveTick(sessionKey, "settled").catch((err) =>
        log.warn("ghost-observer", "reactive tick crashed", { err: (err as Error).message }),
      );
    }, delayMs);
    if (typeof t.unref === "function") t.unref();
    this.pendingReplyTicks.set(sessionKey, t);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const params = resolveIntensity(this.deps.config.brown_nose.intensity);
    const delayMs = randomInRange(params.sweepMin, params.sweepMax) * 60_000;
    this.timer = setTimeout(() => {
      void this.runTick();
    }, delayMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private async runTick(): Promise<void> {
    try {
      const pick = this.pickNext();
      if (!pick) {
        log.debug?.("ghost-observer", "no eligible session — skipping tick");
      } else {
        await this.runReactiveTick(pick.sessionKey as SessionKey, pick.reason);
      }
    } catch (err) {
      log.warn("ghost-observer", "tick crashed", { err: (err as Error).message });
    } finally {
      // Next sweep is scheduled only after this tick fully completes, so
      // a long tool-using tick can never overlap the next one.
      this.scheduleNext();
    }
  }

  /** Used by both periodic and reactive triggers. Records the
   *  reason+timestamp so the picker can de-duplicate. */
  private async runReactiveTick(sessionKey: SessionKey, reason: TickReason): Promise<void> {
    // Never ghost-ticked: trading is a bot channel, and named-orchestrator
    // sessions belong to OTHER personas — the ghost composes outreach as
    // the main persona and must not read (or act on) their private threads.
    // Guest/vouched DMs (isExcludedSession) are never outreach targets.
    if (sessionKey.startsWith("trading:") || sessionKey.startsWith("orch:")) return;
    if (this.deps.isExcludedSession?.(sessionKey)) return;
    // Reactive (post-reply) ticks bypass the picker, so re-apply its
    // spacing floor here — without it, a chatty exchange stacked 4 model
    // calls in 9 minutes on a single quiet chat.
    const lastTick = this.lastTickAtMs.get(sessionKey) ?? 0;
    if (Date.now() - lastTick < MIN_TICK_SPACING_MS) {
      log.debug?.("ghost-observer", "skipping tick — spacing floor", {
        session: sessionKey,
        since_last_ms: Date.now() - lastTick,
      });
      return;
    }
    // Daily hard cap (config brown_nose.max_ghost_ticks_per_day). Counted
    // from the spend ledger so it survives daemon restarts: with the
    // pre-screen on, every model-invoking tick writes a ghost-prescreen
    // row; with it off, a ghost row. max() covers both configurations.
    const cap = this.deps.config.brown_nose.max_ghost_ticks_per_day;
    try {
      const ledger = getSpendLedger(this.deps.config.paths.data_dir);
      const day = localDay(Date.now());
      const used = Math.max(
        ledger.countDay(day, sessionKey, "ghost"),
        ledger.countDay(day, sessionKey, "ghost-prescreen"),
      );
      if (used >= cap) {
        log.info("ghost-observer", "skipping tick — daily cap reached", {
          session: sessionKey,
          used,
          cap,
        });
        return;
      }
    } catch (err) {
      // Cap accounting must never mute the ghost — fall through.
      log.warn("ghost-observer", "daily-cap check failed", { err: (err as Error).message });
    }
    log.info("ghost-observer", "tick", { session: sessionKey, reason });
    this.ensureEnrolled(sessionKey);
    // Record BEFORE the (now async, possibly minutes-long) model run: the
    // timestamp doubles as the in-flight guard — the spacing floor blocks
    // any other trigger path from double-ticking this session meanwhile.
    this.recordTick(sessionKey, reason);
    const decision = await runGhostTick({ sessionKey, trigger: reason }, this.deps);
    this.applySnooze(sessionKey, decision);
    this.maybeEnqueue(sessionKey, decision);
  }

  /** Persist a ghost-requested snooze (act:false + snoozeUntilMs). The
   *  picker honors it for free; new inbound always voids it. */
  private applySnooze(sessionKey: SessionKey, decision: GhostDecision): void {
    if (decision.act || !decision.snoozeUntilMs) return;
    this.deps.prefs.setSnooze(sessionKey, decision.snoozeUntilMs);
    log.info("ghost-observer", "snoozed by ghost", {
      session: sessionKey,
      until: new Date(decision.snoozeUntilMs).toISOString(),
    });
  }

  /**
   * Enrollment safety net. Boot-time autoEnrollSessions only covers
   * sessions that existed at boot — a contact whose first-ever message
   * arrives mid-run had no prefs row, so every ghost tick for them died
   * with "no prefs row" until the next daemon restart (77 such ticks in
   * the first month of telemetry). Enroll on first touch instead, with
   * the same defaults boot enrollment uses.
   */
  private ensureEnrolled(sessionKey: SessionKey) {
    if (sessionKey.startsWith("trading:") || sessionKey.startsWith("orch:")) return null;
    if (this.deps.isExcludedSession?.(sessionKey)) return null;
    const existing = this.deps.prefs.get(sessionKey);
    if (existing) return existing;
    const cfg = this.deps.config.brown_nose;
    const isGroup = isGroupSession(sessionKey);
    const intensityParams = resolveIntensity(cfg.intensity);
    const created = this.deps.prefs.upsert(sessionKey, {
      defaultsIfNew: {
        enabled: isGroup ? cfg.groups_enabled_by_default : cfg.dms_enabled_by_default,
        activeHours: isGroup ? DEFAULT_ACTIVE_HOURS_GROUP : DEFAULT_ACTIVE_HOURS_DM,
        timezone: cfg.default_timezone,
        weeklyCap: intensityParams.weeklyCap,
      },
    });
    log.info("ghost-observer", "enrolled session on first touch", {
      session: sessionKey,
      enabled: created.enabled,
    });
    return created;
  }

  private pickNext() {
    const candidates = this.deps.prefs
      .list()
      .filter((p) => p.enabled && p.activeHours.length > 0)
      // A prefs row that predates a guest exclusion (or a handle that later
      // became a guest) must fall out of the candidate pool, not just fail
      // enrollment.
      .filter((p) => !this.deps.isExcludedSession?.(p.sessionKey as SessionKey));
    const activity = new Map<string, SessionActivity>();
    for (const c of candidates) {
      const s = this.deps.state.getSession(c.sessionKey as SessionKey);
      activity.set(c.sessionKey, {
        lastInboundMs: s?.lastInboundMs ?? 0,
        lastOutboundMs: s?.lastOutboundMs ?? 0,
      });
    }
    return pickNextSession({
      candidates,
      activity,
      lastTickAtMs: this.lastTickAtMs as Map<string, number>,
      lastTickByReason: this.lastTickByReason,
      nowMs: Date.now(),
    });
  }

  private recordTick(sessionKey: SessionKey, reason: TickReason): void {
    const now = Date.now();
    this.lastTickAtMs.set(sessionKey, now);
    let perReason = this.lastTickByReason.get(sessionKey);
    if (!perReason) {
      perReason = new Map();
      this.lastTickByReason.set(sessionKey, perReason);
    }
    perReason.set(reason, now);
  }

  /**
   * The newest fires that reached this chat, labels checked against what
   * the chat shows (ghost/landed.ts). The queue's 48h spacing runs on these.
   */
  contactFires(sessionKey: SessionKey, limit: number) {
    const nowMs = Date.now();
    return withLandingEvidence(
      this.deps.prefs.recentFires(sessionKey, limit + 10),
      sessionKey,
      this.deps,
      nowMs,
      this.deps.prefs,
    )
      .filter((f) => isContact(f, nowMs))
      .slice(0, limit);
  }

  /** When the ghost says act:true, enqueue a brown-nose cron row. The
   *  scheduler picks it up at fireAtMs and routes through proactive/fire.ts. */
  private maybeEnqueue(sessionKey: SessionKey, decision: GhostDecision): void {
    if (!decision.act) return;
    const res = enqueueBrownNoseFire({
      sessionKey,
      decision,
      config: this.deps.config,
      crons: this.deps.crons,
      // Lets the queue clamp an out-of-window fire time to the next window
      // opening instead of letting the fire-time gate drop the brief.
      sessionPrefs: this.deps.prefs.get(sessionKey),
      // Enforces the 48h hard-spacing floor against the last fire that
      // reached the person; vetoed, errored and interrupted fires did not.
      prefsStore: {
        recentFires: (key: SessionKey, limit: number) => this.contactFires(key, limit),
      },
    });
    if (!res.enqueued) {
      log.warn("ghost-observer", "enqueue failed", {
        session: sessionKey,
        reason: res.reason,
      });
      // Write the failure into the decision log — without this, the next
      // tick sees its prior ACT and assumes the fire was delivered (a
      // ghost once skipped a real hook because of that phantom fire).
      recordDecisionNote(sessionKey, {
        act: false,
        reason: `prior ACT was NOT delivered — enqueue failed: ${res.reason}. The hook is still live if it hasn't expired.`,
        tickAtMs: Date.now(),
      });
    }
  }
}

function randomInRange(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}
