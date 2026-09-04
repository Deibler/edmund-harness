import { log } from "../util/log.ts";
import { type ProbeRunner, evaluateTrigger } from "./evaluate.ts";
import type { DataTrigger, DataTriggerStore } from "./store.ts";

/**
 * Polls armed data triggers and fires a system event into the owning
 * session when a model-authored condition triggers. The model is invoked
 * exactly once per real event, already holding the triggering data —
 * instead of being woken for every empty check. Mirrors trading's
 * TriggerWatcher.
 */

export type DataTriggerWatcherOpts = {
  store: DataTriggerStore;
  /** Loop tick. Each trigger also has its own check_interval gate. */
  intervalMs: number;
  /** Inject a one-shot systemEvent into a session (wired to CronStore). */
  fire: (sessionKey: string, systemEvent: string) => void;
  probe: ProbeRunner;
  onError?: (err: unknown) => void;
  /** Called once when a trigger crosses PERSISTENT_FAILURE_ALERT_AT
   *  consecutive failures — wired to the operator alert in main.ts. */
  onPersistentFailure?: (t: DataTrigger, error: string, failures: number) => void;
  /** Called once when a trigger is auto-disarmed at
   *  PERSISTENT_FAILURE_DISARM_AT — wired to the operator alert in main.ts. */
  onAutoDisarm?: (t: DataTrigger, error: string, failures: number) => void;
};

/** Escalate to the operator at exactly this many consecutive failures. */
export const PERSISTENT_FAILURE_ALERT_AT = 5;

/**
 * Give up at this many consecutive failures and disarm.
 *
 * The alert at 5 assumed someone would then repair or cancel the trigger.
 * Nobody does — the alert is one line in a busy thread, and the backoff
 * floor below means the corpse keeps probing hourly regardless. Three
 * kitchen triggers reached 100+ consecutive failures over four days, each
 * pointed at a `trycloudflare.com` hostname that had been regenerated,
 * i.e. at a URL that could never come back. Past a day of solid failure
 * the endpoint is gone, not flaky, and retrying is pure noise.
 */
export const PERSISTENT_FAILURE_DISARM_AT = 24;

/** Backoff ceiling — a failing trigger is retried at most hourly. */
const MAX_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

/**
 * How long to wait since lastCheckedMs before evaluating again. Clean
 * triggers use their own cadence; failing ones back off exponentially so a
 * dead endpoint doesn't get hammered every tick for days (the pre-backoff
 * behavior: a broken 2m trigger = 720 failed probes/day, forever).
 */
export function effectiveIntervalMs(t: DataTrigger): number {
  if (t.consecutiveFailures <= 0) return t.checkIntervalMs;
  const backoff = t.checkIntervalMs * 2 ** Math.min(t.consecutiveFailures, 10);
  return Math.min(backoff, Math.max(t.checkIntervalMs, MAX_FAILURE_BACKOFF_MS));
}

export class DataTriggerWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private opts: DataTriggerWatcherOpts) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One evaluation pass. Re-entrancy guarded; per-trigger errors isolated. */
  async tick(nowMs = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const expired = this.opts.store.expireSweep(nowMs);
      if (expired > 0) log.info("trigger", `expired ${expired} past-deadline trigger(s)`);

      for (const t of this.opts.store.listArmed()) {
        if (nowMs - t.lastCheckedMs < effectiveIntervalMs(t)) continue;
        try {
          await this.evaluate(t, nowMs);
        } catch (err) {
          // A failing probe/predicate must not kill the loop or other
          // triggers. The error lands on the trigger row so the model can
          // see and repair it via list_triggers; repeat failures back off
          // (effectiveIntervalMs) and escalate once to the operator.
          const msg = err instanceof Error ? err.message : String(err);
          const failures = t.consecutiveFailures + 1;
          this.opts.store.markChecked(t.id, nowMs, undefined, msg.slice(0, 300));
          log.warn("trigger", `check failed id=${t.id} (${t.name}) — failure #${failures}`, {
            err: msg,
          });
          if (failures === PERSISTENT_FAILURE_ALERT_AT) {
            this.opts.onPersistentFailure?.(t, msg, failures);
          }
          // Terminal state. Without this the row stays armed forever and
          // the hourly floor turns a dead endpoint into permanent noise.
          // `>=` not `===`: a trigger already past the line when this
          // shipped must still be able to reach it.
          if (failures >= PERSISTENT_FAILURE_DISARM_AT) {
            this.opts.store.cancel(t.id);
            log.warn(
              "trigger",
              `auto-disarmed id=${t.id} (${t.name}) after ${failures} consecutive failures`,
              { err: msg },
            );
            this.opts.onAutoDisarm?.(t, msg, failures);
          }
        }
      }
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(t: DataTrigger, nowMs: number): Promise<void> {
    const result = await evaluateTrigger(t.source, t.predicate, t.state, this.opts.probe);

    if (!result.fire) {
      this.opts.store.markChecked(t.id, nowMs, result.state, null);
      return;
    }

    // Cooldown: a re-fireable trigger that just fired holds its tongue but
    // STILL advances its state, so suppressed events can't fire stale later.
    if (!t.oneShot && t.lastFiredMs > 0 && nowMs - t.lastFiredMs < t.cooldownMs) {
      this.opts.store.markChecked(t.id, nowMs, result.state, null);
      log.info("trigger", `fire suppressed by cooldown id=${t.id} (${t.name})`);
      return;
    }

    // Record BEFORE firing so a crash mid-fire can't double-fire.
    this.opts.store.markChecked(t.id, nowMs, result.state, null);
    const newStatus = this.opts.store.recordFire(t.id, nowMs, result.state);
    log.info("trigger", `FIRED id=${t.id} (${t.name}) → ${t.sessionKey}`);
    this.opts.fire(t.sessionKey, buildFireEvent(t, result.summary, newStatus));
  }
}

/**
 * Triggers carry no domain tag, so weather-ness is inferred: an app_js
 * probe IS the RadarOmega renderer, and url probes betray the domain in
 * the endpoint/name/brief. A false positive just adds one paragraph of
 * guidance; a miss loses nothing the brief didn't already say.
 */
function isWeatherTrigger(t: DataTrigger): boolean {
  if (t.source.kind === "app_js") return true;
  const url = t.source.kind === "url" ? t.source.url : "";
  const hay = `${url} ${t.name} ${t.brief}`.toLowerCase();
  return /weather\.gov|noaa\.gov|nhc\.|spc\.|radar|storm|tornado|hurricane|blizzard|snowfall|flood|lightning/.test(
    hay,
  );
}

export function buildFireEvent(t: DataTrigger, summary: string, newStatus: string): string {
  const lines = [
    `[Trigger fired: ${t.name}] (id ${t.id})`,
    ``,
    `Your brief when you armed this: ${t.brief}`,
    ``,
    `What the check found:`,
    summary,
    ``,
    `This is YOUR trigger — deliver on the brief now. If the data above already answers`,
    `the brief, just send the message; reach for tools only where the brief needs them.`,
  ];
  if (isWeatherTrigger(t)) {
    lines.push(
      ``,
      `Weather delivery bar: RadarOmega on the affected area, the right products/overlays,`,
      `meteorologist-grade annotation, capture_view (or capture_loop for motion), then ONE`,
      `message leading with event, location, timing, action.`,
    );
  }
  lines.push(
    newStatus === "done"
      ? `This was a one-shot trigger and is now done.`
      : `This trigger stays armed (cooldown applies). cancel_trigger("${t.id}") if it's served its purpose.`,
  );
  return lines.join("\n");
}
