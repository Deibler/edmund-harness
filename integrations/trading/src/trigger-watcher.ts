import type { Broker } from "./broker.ts";
import type { PriceTrigger, TriggerStore } from "./trigger-store.ts";

/**
 * Polls armed price triggers and fires a system event into the owning trading
 * session when a threshold crosses. Runs in the daemon alongside the cron
 * scheduler. Two modes:
 *
 *  - QUOTE mode (code broker available): fetch quotes for the distinct armed
 *    symbols, evaluate each trigger, fire on a real cross, mark fired.
 *  - NUDGE mode (no code broker — in-session auth only): the daemon can't pull
 *    quotes, so periodically nudge the trading session ("you have N armed
 *    triggers — fetch quotes and act") and let the model (which holds the
 *    Robinhood tools) evaluate. Rate-limited so it doesn't spam.
 *
 * Firing reuses the one-shot-cron wake mechanism via the injected `fire`
 * callback (the daemon wires it to CronStore), so no new fire path is needed.
 */
export type TriggerWatcherOpts = {
  store: TriggerStore;
  intervalMs: number;
  /** Code-level broker for quotes, or null → nudge mode. */
  broker: Broker | null;
  /** Inject a one-shot systemEvent into a session (daemon wires to CronStore). */
  fire: (sessionKey: string, systemEvent: string) => void;
  /** Min ms between nudges to the same session in nudge mode. */
  nudgeIntervalMs?: number;
  onError?: (err: unknown) => void;
};

export class TriggerWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastNudgeBySession = new Map<string, number>();
  private readonly nudgeIntervalMs: number;

  constructor(private opts: TriggerWatcherOpts) {
    this.nudgeIntervalMs = opts.nudgeIntervalMs ?? 5 * 60 * 1000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run one evaluation pass. Safe to call directly (e.g. right after a new
   *  trigger is registered). Re-entrancy guarded. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const armed = this.opts.store.listArmed();
      if (armed.length === 0) return;
      if (this.opts.broker) {
        await this.quoteMode(armed);
      } else {
        this.nudgeMode(armed);
      }
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.ticking = false;
    }
  }

  private async quoteMode(armed: PriceTrigger[]): Promise<void> {
    const symbols = [...new Set(armed.map((t) => t.symbol))];
    const quotes = await this.opts.broker!.getQuotes(symbols);
    const price = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q.last]));
    const now = Date.now();
    for (const t of armed) {
      const p = price.get(t.symbol.toUpperCase());
      this.opts.store.markChecked(t.id, now);
      if (p === undefined || !(p > 0)) continue;
      const crossed = t.direction === "above" ? p >= t.threshold : p <= t.threshold;
      if (!crossed) continue;
      // Mark fired BEFORE firing so a crash mid-fire can't double-fire.
      this.opts.store.markFired(t.id, now);
      const dir = t.direction === "above" ? "rose to/above" : "fell to/below";
      this.opts.fire(
        t.sessionKey,
        `[PRICE_TRIGGER] ${t.symbol} ${dir} ${t.threshold} (now ${p}).${t.note ? ` Note: ${t.note}.` : ""} Re-check your thesis and act per policy.`,
      );
    }
  }

  private nudgeMode(armed: PriceTrigger[]): void {
    const now = Date.now();
    const bySession = new Map<string, PriceTrigger[]>();
    for (const t of armed) {
      const list = bySession.get(t.sessionKey) ?? [];
      list.push(t);
      bySession.set(t.sessionKey, list);
    }
    for (const [sessionKey, list] of bySession) {
      const last = this.lastNudgeBySession.get(sessionKey) ?? 0;
      if (now - last < this.nudgeIntervalMs) continue;
      this.lastNudgeBySession.set(sessionKey, now);
      for (const t of list) this.opts.store.markChecked(t.id, now);
      const desc = list.map((t) => `${t.symbol} ${t.direction} ${t.threshold}`).join(", ");
      this.opts.fire(
        sessionKey,
        `[PRICE_TRIGGER_CHECK] You have ${list.length} armed price trigger(s): ${desc}. Fetch fresh quotes via your Robinhood tools; for any that have crossed, act per policy and cancel the trigger (cancel_price_trigger).`,
      );
    }
  }
}
