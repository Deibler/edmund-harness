import { AgentStore } from "../../../src/agents/store.ts";
import type { SessionKey } from "../../../src/sessions/key.ts";

/**
 * One job the mirror is still waiting on.
 *
 * `task` rides along because the agents table is the only place it exists —
 * the turn that spawned the job ended, and the model cannot report on work it
 * can no longer see. Without it the glass can say something is happening but
 * not what, which is the difference between "working" and "working on the
 * eligibility numbers".
 */
export type MirrorBackgroundJob = {
  id: string;
  task: string;
  spawnedAtMs: number;
};

/**
 * Watches the sub-agents the mirror session is still waiting on.
 *
 * Polling looks crude next to an event, but the agents table is genuinely the
 * only shared truth here: `spawn_agent` runs inside an MCP subprocess, not the
 * daemon, so nothing in this process ever sees a job being created. The same
 * table is what `list_agents` reads, and the query is a covering index hit on
 * `(parent_session_key, status)`.
 *
 * Why it exists at all: a long job is normally started by a turn that then
 * ENDS — the model says "give me a minute", spawns the agent, and finishes.
 * Without this, the volley closes on that turn, the dock folds, and the work
 * becomes invisible until its result repaints the glass out of nowhere.
 */
export class MirrorBackgroundWatch {
  private readonly store: AgentStore;
  private readonly sessionKey: SessionKey;
  private readonly onWork: (jobs: MirrorBackgroundJob[]) => void;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    dataDir: string;
    sessionKey: SessionKey;
    onWork: (jobs: MirrorBackgroundJob[]) => void;
    /** Poll cadence. Fast enough that the dock reacts within a beat of a job
     *  starting or finishing, slow enough to be free. */
    intervalMs?: number;
  }) {
    this.store = new AgentStore(opts.dataDir);
    this.sessionKey = opts.sessionKey;
    this.onWork = opts.onWork;
    this.intervalMs = opts.intervalMs ?? 4_000;
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests and for a caller that wants an immediate reconcile. */
  tick(): void {
    try {
      // Pending counts as in flight: a job that has been created but has not
      // reported its pid yet is still work he is waiting on.
      const jobs = [
        ...this.store.list({ parentSessionKey: this.sessionKey, status: "pending" }),
        ...this.store.list({ parentSessionKey: this.sessionKey, status: "running" }),
      ].map((agent) => ({
        id: agent.id,
        task: agent.task,
        spawnedAtMs: agent.spawnedAt,
      }));
      this.onWork(jobs);
    } catch (err) {
      // Never a reason to disturb the glass — a failed read just means this
      // tick reports nothing, and the next one corrects it.
      console.warn(
        `[mirror] background watch read failed: ${(err as Error).message.slice(0, 160)}`,
      );
    }
  }
}
