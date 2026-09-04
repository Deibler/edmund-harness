import { log } from "../util/log.ts";
import type { RefreshScript, RefreshScriptStore } from "./store.ts";

/**
 * Executes armed refresh scripts on schedule and applies their output —
 * the deterministic half of "model authors once, daemon repeats for free".
 * Mirrors DataTriggerWatcher: re-entrancy guarded, per-script failures
 * isolated, exponential backoff, one-shot escalation to the owning
 * session's model when a script fails persistently.
 */

/** Scripts do real network fetches — give them more room than predicates. */
const REFRESH_SCRIPT_TIMEOUT_MS = 45_000;

/** Escalate to the owning session's model at exactly this many failures. */
export const PERSISTENT_REFRESH_FAILURE_AT = 3;

/** Backoff ceiling — a broken hourly refresh still retries every 6h. */
const MAX_REFRESH_BACKOFF_MS = 6 * 60 * 60 * 1000;

const EVALUATOR_URL = new URL("./script-eval.ts", import.meta.url);

export type ScriptRunOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** Run a script body in an isolated worker with a hard timeout. */
export async function runRefreshScriptSource(
  script: string,
  timeoutMs = REFRESH_SCRIPT_TIMEOUT_MS,
): Promise<ScriptRunOutcome> {
  return new Promise((resolve) => {
    const worker = new Worker(EVALUATOR_URL, { name: "refresh-script" });
    let settled = false;
    const finish = (outcome: ScriptRunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: `script timed out after ${Math.round(timeoutMs / 1000)}s and was terminated`,
        }),
      timeoutMs,
    );
    timer.unref?.();
    worker.onmessage = (event: MessageEvent<ScriptWorkerResponse>) => {
      const response = event.data;
      finish(
        response.ok
          ? { ok: true, value: response.value }
          : { ok: false, error: response.error || "script failed" },
      );
    };
    worker.onerror = (event: ErrorEvent) => {
      finish({ ok: false, error: event.message || "script worker crashed" });
    };
    worker.postMessage({ script });
  });
}

type ScriptWorkerResponse = { ok: true; value: unknown } | { ok: false; error: string };

/** Interval with failure backoff (2^n, capped) — same shape as triggers. */
export function effectiveRefreshIntervalMs(s: RefreshScript): number {
  if (s.consecutiveFailures <= 0) return s.intervalMs;
  const backoff = s.intervalMs * 2 ** Math.min(s.consecutiveFailures, 6);
  return Math.min(backoff, Math.max(s.intervalMs, MAX_REFRESH_BACKOFF_MS));
}

type RefreshApplyResult = { ok: true; summary: string } | { ok: false; error: string };

export type RefreshWatcherOpts = {
  store: RefreshScriptStore;
  /** Loop tick; each script also has its own interval (+ backoff) gate. */
  intervalMs: number;
  /** Apply a script's returned value (dispatches on script.applyKind). */
  apply: (script: RefreshScript, value: unknown) => Promise<RefreshApplyResult>;
  /** Fired once when a script crosses PERSISTENT_REFRESH_FAILURE_AT —
   *  wired to a one-shot repair cron into the owning session. */
  escalate?: (script: RefreshScript, error: string, failures: number) => void;
  onError?: (err: unknown) => void;
};

export class RefreshWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private opts: RefreshWatcherOpts) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(nowMs = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const s of this.opts.store.listArmed()) {
        if (nowMs - s.lastRunMs < effectiveRefreshIntervalMs(s)) continue;
        try {
          await this.refresh(s, nowMs);
        } catch (err) {
          // Belt over the per-step handling below — one broken script must
          // never kill the loop for the others.
          const msg = err instanceof Error ? err.message : String(err);
          this.recordFailure(s, nowMs, msg);
        }
      }
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.ticking = false;
    }
  }

  private async refresh(s: RefreshScript, nowMs: number): Promise<void> {
    const run = await runRefreshScriptSource(s.script);
    if (!run.ok) {
      this.recordFailure(s, nowMs, `run: ${run.error}`);
      return;
    }
    const applied = await this.opts.apply(s, run.value);
    if (!applied.ok) {
      this.recordFailure(s, nowMs, `apply: ${applied.error}`);
      return;
    }
    this.opts.store.markRun(s.id, nowMs, { ok: true, summary: applied.summary });
    log.info("refresh", `applied ${s.name}`, { id: s.id, summary: applied.summary });
  }

  private recordFailure(s: RefreshScript, nowMs: number, error: string): void {
    const failures = s.consecutiveFailures + 1;
    this.opts.store.markRun(s.id, nowMs, { ok: false, error });
    log.warn("refresh", `script failed ${s.name} — failure #${failures}`, {
      id: s.id,
      err: error,
    });
    if (failures === PERSISTENT_REFRESH_FAILURE_AT) {
      this.opts.escalate?.(s, error, failures);
    }
  }
}

/** The one-shot repair event injected into the owning session. */
export function buildRefreshRepairEvent(s: RefreshScript, error: string, failures: number): string {
  return [
    `[Refresh script failing: ${s.name}] (id ${s.id}) — ${failures} consecutive failures.`,
    ``,
    `Last error: ${error}`,
    ``,
    `Its job: ${s.brief}`,
    ``,
    `Do BOTH now:`,
    `1. Refresh the content manually this turn so it isn't stale.`,
    `2. Fix or retire the script — inspect with list_refresh_scripts, replace it via`,
    `   set_refresh_script (same name), or cancel_refresh_script if this should go back`,
    `   to being a scheduled model turn. Until it succeeds, its checks are backing off.`,
  ].join("\n");
}
