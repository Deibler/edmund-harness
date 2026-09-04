import type { SessionKey } from "../sessions/key.ts";
import { log } from "../util/log.ts";
import { type MaintenanceDeps, runMaintenance } from "./maintainer.ts";

/**
 * Schedules `runMaintenance` calls after the main model replies. Mirrors
 * the shape of `GhostObserver.onMainReplied`:
 *
 *   - Dedup'd timer per session (60-120s deferred), so a rapid follow-up
 *     reply resets rather than schedules a second run.
 *   - Per-session min-interval (config.people_maintainer.min_interval_minutes)
 *     hard floor — prevents bursty back-and-forth from spending Haiku tokens
 *     every few seconds.
 *   - Runs regardless of brown-nose state (deliberately decoupled from the
 *     ghost; turning proactive outreach off doesn't mute memory hygiene).
 *
 * Failures are caught and logged — maintenance is enrichment, never on the
 * critical reply path.
 */
export class PersonMaintainer {
  private pending = new Map<SessionKey, ReturnType<typeof setTimeout>>();
  private lastRunAtMs = new Map<SessionKey, number>();
  private stopped = false;

  constructor(private readonly deps: MaintenanceDeps) {}

  onMainReplied(sessionKey: SessionKey): void {
    if (this.stopped || !this.deps.config.people_maintainer.enabled) return;
    // Reset any existing pending timer for this session.
    const existing = this.pending.get(sessionKey);
    if (existing) clearTimeout(existing);
    const delayMs = 60_000 + Math.floor(Math.random() * 60_000); // 60-120s
    const t = setTimeout(() => {
      this.pending.delete(sessionKey);
      void this.runIfDue(sessionKey);
    }, delayMs);
    if (typeof t.unref === "function") t.unref();
    this.pending.set(sessionKey, t);
  }

  async runNow(sessionKey: SessionKey): Promise<void> {
    await this.runIfDue(sessionKey, { bypassMinInterval: true });
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private async runIfDue(
    sessionKey: SessionKey,
    opts: { bypassMinInterval?: boolean } = {},
  ): Promise<void> {
    const minIntervalMs = this.deps.config.people_maintainer.min_interval_minutes * 60_000;
    const lastRun = this.lastRunAtMs.get(sessionKey) ?? 0;
    const since = Date.now() - lastRun;
    if (!opts.bypassMinInterval && since < minIntervalMs) {
      log.debug?.("maintainer", "skipping — min interval not elapsed", {
        session: sessionKey,
        since_min: Math.round(since / 60_000),
      });
      return;
    }
    try {
      const result = await runMaintenance(sessionKey, this.deps);
      this.lastRunAtMs.set(sessionKey, Date.now());
      if (!result.ok) {
        log.debug?.("maintainer", "no-op", { session: sessionKey, reason: result.reason });
      }
    } catch (err) {
      log.warn("maintainer", "run crashed", {
        session: sessionKey,
        err: (err as Error).message,
      });
    }
  }
}
