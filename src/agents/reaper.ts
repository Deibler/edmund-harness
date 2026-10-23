import type { CronStore } from "../cron/store.ts";
import { PENDING_STALE_MS, killAgentProcess, notifyParent } from "./spawn.ts";
import type { AgentStore } from "./store.ts";
import type { Agent, AgentLimits } from "./types.ts";

/**
 * When the daemon stops an agent. Measured 2026-10-23 on the live store:
 * finished agents ran up to 18.3 minutes (p99 15.5) and went at most 482s
 * without output (p99 363s), so 15 minutes of silence is a hang, not a long
 * tool call. The cap bounds a run that keeps talking but never finishes.
 * The old rule was 15 minutes since spawn: 33 of the 35 agents it reaped had
 * written output within the last 151s, 29 of them within the last minute.
 */
export const AGENT_LIMITS: AgentLimits = {
  pendingStaleMs: PENDING_STALE_MS,
  idleMs: 15 * 60_000,
  maxRunMs: 90 * 60_000,
};

/** What the parent is told about why its agent was stopped. */
export function stuckReason(agent: Agent, limits: AgentLimits, now = Date.now()): string {
  if (agent.status === "pending") return "never started (the runner did not come up)";
  if (agent.spawnedAt < now - limits.maxRunMs) {
    return `stopped at the ${Math.round(limits.maxRunMs / 60_000)}-minute limit for a sub-agent`;
  }
  const quiet = Math.round((now - (agent.heartbeatAt ?? agent.spawnedAt)) / 60_000);
  return `stopped after ${quiet} minutes without any output`;
}

/**
 * Daemon-level reaper, run every minute from wire-recovery. Catches agents
 * nothing else will settle: a runner that never started, one that crashed
 * before its exit hook, a CLI that hangs. Each agent it stops is settled
 * first (so its runner's SIGTERM handler, which writes the partial result,
 * does not report it a second time), then its process group is stopped and
 * the parent is told why.
 */
export function reapStuckAgents(
  store: AgentStore,
  crons: Pick<CronStore, "coalesceOnce" | "cancelPokes">,
  dataDir: string,
  limits: AgentLimits = AGENT_LIMITS,
  now = Date.now(),
): string[] {
  const reaped: string[] = [];
  for (const a of store.listStuck(limits, now)) {
    const reason = stuckReason(a, limits, now);
    if (!store.finishIfActive(a.id, "failed", null, reason)) continue;
    if (a.pid) killAgentProcess(a.pid);
    console.warn(`[agents] reaper: ${a.id} ${reason}; killed pid=${a.pid ?? "?"}`);
    reaped.push(a.id);
    const settled = store.get(a.id);
    if (settled) notifyParent({ store, crons, dataDir, agent: settled, note: reason });
  }
  return reaped;
}
