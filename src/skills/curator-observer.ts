/**
 * Cadence for the skill curator.
 *
 * Unlike the person maintainer, this is not triggered by a reply. Its whole
 * premise is cross-conversation — it is looking for the thing no single
 * conversation can see — so it runs on a wall clock, slowly, and its state
 * lives on disk rather than in memory: a daemon that restarts twice a day
 * must not get two passes a day out of it.
 *
 * First run is deliberately deferred past boot. Nothing about a pattern that
 * took weeks to form is urgent, and a curator racing the recall indexer at
 * startup would sample a half-built window.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../util/log.ts";
import { type CuratorDeps, type CuratorOutcome, runCurator } from "./curator.ts";
import { type LifecycleOutcome, runLifecycle } from "./lifecycle.ts";

/** How long after boot the first pass may run. */
const BOOT_DELAY_MS = 30 * 60_000;
/** How often to CHECK whether a pass is due. The pass itself is gated by
 *  `min_interval_hours` against the persisted timestamp. */
const TICK_MS = 60 * 60_000;

/**
 * Deps for both halves of the pass. The curator needs contacts (for the leak
 * scan); the lifecycle needs the consent store (retiring a skill revokes the
 * agreements people gave it). One object, so the daemon wires it once.
 */
export type SkillCuratorDeps = CuratorDeps & { consentDbPath: string };

type CuratorState = { last_run_ms: number; last_created: string | null };

function statePath(dataDir: string): string {
  return join(dataDir, "skill-curator.json");
}

export function readCuratorState(dataDir: string): CuratorState {
  const p = statePath(dataDir);
  if (!existsSync(p)) return { last_run_ms: 0, last_created: null };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as CuratorState;
    return {
      last_run_ms: typeof parsed.last_run_ms === "number" ? parsed.last_run_ms : 0,
      last_created: typeof parsed.last_created === "string" ? parsed.last_created : null,
    };
  } catch {
    return { last_run_ms: 0, last_created: null };
  }
}

export function writeCuratorState(dataDir: string, state: CuratorState): void {
  const p = statePath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

export class SkillCurator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: SkillCuratorDeps) {}

  start(): void {
    if (!this.deps.config.skill_curator.enabled) return;
    this.bootTimer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
    }, BOOT_DELAY_MS);
    this.bootTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.timer = null;
    this.bootTimer = null;
  }

  /** Run now regardless of the interval — the CLI and dashboard entry point. */
  async runNow(): Promise<{ curated: CuratorOutcome; lifecycle: LifecycleOutcome | null }> {
    return this.execute();
  }

  private async tick(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const state = readCuratorState(this.deps.dataDir);
    const dueAt = state.last_run_ms + this.deps.config.skill_curator.min_interval_hours * 3_600_000;
    if (now < dueAt) return;
    await this.execute();
  }

  /**
   * One pass, guarded against overlap.
   *
   * The interval gate lives in `tick`, not here, so `runNow` reaches this
   * directly and is not subject to it.
   *
   * `running` is not paranoia: a pass takes minutes, the tick is hourly, and
   * `runNow` can arrive at any moment. Two concurrent passes would read the
   * same install db, both decide the name is free, and the second write would
   * silently lose the first.
   */
  private async execute(): Promise<{
    curated: CuratorOutcome;
    lifecycle: LifecycleOutcome | null;
  }> {
    if (this.stopped) return { curated: { ran: false, reason: "stopped" }, lifecycle: null };
    if (this.running) {
      return { curated: { ran: false, reason: "a pass is already running" }, lifecycle: null };
    }
    this.running = true;
    try {
      // Lifecycle FIRST. Retirement frees a slot against `max_curated_skills`,
      // so a catalogue sitting at the ceiling with a dead skill in it can
      // still learn something today rather than next week. It also means the
      // curator sees this pass's tombstones and will not re-propose what was
      // just retired.
      let lifecycle: LifecycleOutcome | null = null;
      try {
        lifecycle = await runLifecycle(this.deps);
      } catch (err) {
        log.warn("skill-curator", "lifecycle pass crashed", { err: (err as Error).message });
      }

      const curated = await runCurator(this.deps);
      // Stamp the clock on any pass that actually reached the model, so a run
      // producing nothing still costs a full interval before the next. Only a
      // pass blocked before doing work leaves the clock alone.
      if (curated.ran) {
        writeCuratorState(this.deps.dataDir, {
          last_run_ms: (this.deps.now ?? Date.now)(),
          last_created: curated.created,
        });
      }
      return { curated, lifecycle };
    } catch (err) {
      log.warn("skill-curator", "pass crashed", { err: (err as Error).message });
      return { curated: { ran: false, reason: (err as Error).message }, lifecycle: null };
    } finally {
      this.running = false;
    }
  }
}
