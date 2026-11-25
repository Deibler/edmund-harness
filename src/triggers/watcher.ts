import { humanMs, log } from "../util/log.ts";
import { type ProbeRunner, RateLimitedError, evaluateTrigger } from "./evaluate.ts";
import type { DataTrigger, DataTriggerStore } from "./store.ts";
import { PERSISTENT_FAILURE_ALERT_AT, PERSISTENT_FAILURE_DISARM_AT } from "./thresholds.ts";

export { PERSISTENT_FAILURE_ALERT_AT, PERSISTENT_FAILURE_DISARM_AT };

/**
 * Polls armed data triggers and fires a system event into the owning
 * session when a model-authored condition triggers. The model is invoked
 * exactly once per real event, already holding the triggering data —
 * instead of being woken for every empty check.
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

/** How long a host is left alone after a 429 that did not say. */
const RATE_LIMIT_DEFAULT_WAIT_MS = 2 * 60_000;
/** Bounds on what a Retry-After may ask of us: at least a tick's worth of
 *  quiet, and never so long that the trigger is as good as disarmed. */
const RATE_LIMIT_MIN_WAIT_MS = 30_000;
const RATE_LIMIT_MAX_WAIT_MS = 60 * 60_000;
/** After a host rate limits us, its triggers are checked one per tick for
 *  this long instead of all of them back to back. */
const CAREFUL_FOR_MS = 60 * 60_000;
/** A trigger rate limited this many times in a row is failing, whatever the
 *  status code says, and goes down the ordinary failure path. */
export const RATE_LIMIT_IS_FAILURE_AT = 3;

/** The host a trigger's probe talks to, when it talks to one. */
function probeHost(t: DataTrigger): string | null {
  if (t.source.kind !== "url") return null;
  try {
    return new URL(t.source.url).host;
  } catch {
    return null;
  }
}

export class DataTriggerWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Host -> when it may be asked again. In memory: a restart forgets it,
   *  and the worst that follows is one more 429. */
  private readonly quietUntil = new Map<string, number>();
  private readonly carefulUntil = new Map<string, number>();
  /** Trigger id -> rate limits in a row. */
  private readonly rateLimited = new Map<string, number>();

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

      // Longest-unchecked first, so that when a host is down to one check a
      // tick the same trigger does not take the turn every time.
      const armed = [...this.opts.store.listArmed()].sort(
        (a, b) => a.lastCheckedMs - b.lastCheckedMs,
      );
      for (const t of armed) {
        if (nowMs - t.lastCheckedMs < effectiveIntervalMs(t)) continue;
        const host = probeHost(t);
        // A host that asked for quiet gets it. The trigger stays due and is
        // checked on the first tick after.
        if (host && (this.quietUntil.get(host) ?? 0) > nowMs) continue;
        if (host && (this.carefulUntil.get(host) ?? 0) > nowMs) {
          // One check of this host per tick: the rest of its triggers wait.
          this.quietUntil.set(host, nowMs + 1);
        }
        try {
          await this.evaluate(t, nowMs);
          this.rateLimited.delete(t.id);
        } catch (err) {
          if (err instanceof RateLimitedError && host && this.comeBackLater(t, host, err, nowMs)) {
            continue;
          }
          this.rateLimited.delete(t.id);
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

  /**
   * A rate limit: leave the host alone for as long as it asked, and count
   * nothing against the trigger. False once the same trigger has been turned
   * away RATE_LIMIT_IS_FAILURE_AT times running, which is a failure.
   */
  private comeBackLater(
    t: DataTrigger,
    host: string,
    err: RateLimitedError,
    nowMs: number,
  ): boolean {
    const times = (this.rateLimited.get(t.id) ?? 0) + 1;
    if (times >= RATE_LIMIT_IS_FAILURE_AT) return false;
    this.rateLimited.set(t.id, times);
    const wait = Math.min(
      RATE_LIMIT_MAX_WAIT_MS,
      Math.max(RATE_LIMIT_MIN_WAIT_MS, err.retryAfterMs ?? RATE_LIMIT_DEFAULT_WAIT_MS),
    );
    this.quietUntil.set(host, nowMs + wait);
    this.carefulUntil.set(host, nowMs + wait + CAREFUL_FOR_MS);
    log.info("trigger", `rate limited by ${host}; its checks wait ${humanMs(wait)}`, {
      id: t.id,
      name: t.name,
    });
    return true;
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
