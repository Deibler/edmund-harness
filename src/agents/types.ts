/**
 * Sub-agent types. An agent is a detached CLI process doing a
 * task on Edmund's behalf while the main iMessage loop stays responsive.
 *
 * Agents are scoped to a parent session (the iMessage conversation that
 * spawned them) and optionally a team (Phase 2). Their result files and
 * work directories live inside the parent's sandbox so a per-conversation
 * cleanup naturally reaps stale agents too.
 */

export type AgentStatus = "pending" | "running" | "done" | "failed" | "canceled";

export type Agent = {
  id: string;
  parentSessionKey: string;
  task: string;
  status: AgentStatus;
  pid: number | null;
  spawnedAt: number;
  finishedAt: number | null;
  sandboxPath: string;
  resultPath: string;
  logPath: string;
  exitCode: number | null;
  teamId: string | null;
  role: string | null;
  deliveredAt: number | null;
  /** Last time the runner saw its CLI produce output. */
  heartbeatAt: number | null;
  /** Why the run ended early (reaped, canceled), when it did. */
  stopReason: string | null;
};

/** When the daemon's reaper stops an agent. */
export type AgentLimits = {
  /** Never reached `running`: the runner did not start. */
  pendingStaleMs: number;
  /** Running with no CLI output for this long. */
  idleMs: number;
  /** Running this long, output or not. */
  maxRunMs: number;
};

export type AgentInput = {
  parentSessionKey: string;
  task: string;
  teamId?: string;
  role?: string;
};
