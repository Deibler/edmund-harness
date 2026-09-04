import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { directClaudeEnv } from "../claude/direct-env.ts";
import { CronStore } from "../cron/store.ts";
import { isTradingSession } from "../sessions/key.ts";
import { genId } from "../util/ids.ts";
import { consumeFollowOnMarker, teamSharedDirFor } from "./follow-on.ts";
import { agentCompletionMessage, teamCompletionMessage } from "./messages.ts";
import type { AgentStore } from "./store.ts";
import type { Agent, AgentInput } from "./types.ts";

/**
 * Spawn a detached model worker for a sub-agent. Returns immediately
 * with the Agent row; the worker writes to the agents table as it runs.
 *
 * Runner script path is anchored to this file's location so the caller's
 * cwd doesn't matter (MCP tool calls run with cwd=sandbox).
 */

const RUNNER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "agent-runner.ts",
);

export function spawnAgent(
  store: AgentStore,
  dataDir: string,
  parentSandbox: string,
  input: AgentInput,
  teamSharedDir?: string,
): Agent {
  const id = genId("agent");
  const agentDir = join(parentSandbox, "agents", id);
  mkdirSync(agentDir, { recursive: true });
  const agent = store.create(input, {
    id,
    sandboxPath: agentDir,
    resultPath: join(agentDir, "result.md"),
    logPath: join(agentDir, "agent.log"),
  });

  const env: Record<string, string> = {
    ...directClaudeEnv(),
    AGENT_ID: agent.id,
    AGENT_TASK: agent.task,
    AGENT_SANDBOX: agent.sandboxPath,
    AGENT_RESULT: agent.resultPath,
    AGENT_LOG: agent.logPath,
    EDMUND_DATA_DIR: resolve(dataDir),
  };
  if (teamSharedDir) env.AGENT_TEAM_SHARED = teamSharedDir;
  if (agent.role) env.AGENT_ROLE = agent.role;
  if (agent.teamId) env.AGENT_TEAM_ID = agent.teamId;
  // Trading sub-agents get the trading MCP loadout (Robinhood read tools for
  // research) and a research-only preamble — they never place orders.
  const trading = isTradingSession(input.parentSessionKey);
  if (trading) env.EDMUND_TRADING = "1";

  const child = spawn("bun", [RUNNER_SCRIPT], {
    env,
    detached: true,
    stdio: "ignore",
  });

  child.on("error", (err) => {
    console.error(`[agents] spawn error for ${agent.id}: ${err.message}`);
    markFailedAndNotify(store, dataDir, agent.id, `spawn error: ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    if (code === null && signal) {
      const current = store.get(agent.id);
      if (current && current.status === "pending") {
        console.error(`[agents] child for ${agent.id} died via signal=${signal} before starting`);
        markFailedAndNotify(
          store,
          dataDir,
          agent.id,
          `child died via signal=${signal} before runner started`,
        );
      }
    }
  });
  child.unref();

  console.log(`[agents] spawned ${agent.id} pid=${child.pid} task="${agent.task.slice(0, 80)}"`);
  return agent;
}

export type TeamMember = { role: string; task: string };

/**
 * Spawn a coordinated team. All members share a `team_id`, a shared-scratch
 * directory they can read/write, and a team-completion event fires once
 * when the last member settles (done | failed). Individual member
 * completions are silent.
 */
export function spawnTeam(
  store: AgentStore,
  dataDir: string,
  parentSandbox: string,
  parentSessionKey: string,
  members: TeamMember[],
  opts?: {
    /** Pre-reserved team id (genId("team")) so the caller can mkdir the
     *  shared dir and embed its REAL absolute path in member tasks before
     *  spawning (deep_research does this — no placeholder seam). */
    teamId?: string;
  },
): { teamId: string; agents: Agent[]; sharedDir: string } {
  if (members.length === 0) throw new Error("team must have at least one member");
  const teamId = opts?.teamId ?? genId("team");
  const teamDir = join(parentSandbox, "teams", teamId);
  const sharedDir = join(teamDir, "shared");
  mkdirSync(sharedDir, { recursive: true });

  const agents = members.map((m) =>
    spawnAgent(
      store,
      dataDir,
      parentSandbox,
      {
        parentSessionKey,
        task: m.task,
        role: m.role,
        teamId,
      },
      sharedDir,
    ),
  );

  console.log(`[agents] spawned team ${teamId} with ${agents.length} members`);
  return { teamId, agents, sharedDir };
}

/**
 * Mark an agent failed AND fire a wake-up cron for the parent, so Edmund
 * hears about the dead agent instead of silently losing track of it.
 *
 * Only the normal-exit path (agent-runner.ts) previously wrote the wake-up
 * cron; spawn failures would mark the row but never notify. Parent would
 * wait forever for a result that never comes.
 *
 * For team members: if this failure lets the team fully settle, we fire
 * the team-completion event (not an individual one). Matches the
 * agent-runner contract so team behavior is consistent regardless of how
 * a member died.
 */
function markFailedAndNotify(
  store: AgentStore,
  dataDir: string,
  agentId: string,
  reason: string,
): void {
  try {
    store.finish(agentId, "failed", null);
  } catch (dbErr) {
    console.error(`[agents] failed to mark ${agentId} as failed: ${String(dbErr)}`);
    return;
  }
  try {
    const agent = store.get(agentId);
    if (!agent) return;
    const crons = new CronStore(dataDir);
    if (agent.teamId) {
      // Same zombie-reap + fully-settled check as agent-runner does, so a
      // spawn-failed teammate still lets the team settle.
      store.teamReapZombies(agent.teamId, {
        pendingStaleMs: 60_000,
        runningStaleMs: 15 * 60 * 1000,
      });
      if (store.teamFullySettled(agent.teamId)) {
        // A follow-on marker (deep_research's synthesizer) takes precedence
        // over the team-done fire: spawning it un-settles the team, and the
        // completion event goes out when IT finishes. Mirrors agent-runner.
        const sharedDir = teamSharedDirFor(agent.sandboxPath, agent.teamId);
        const spec = consumeFollowOnMarker(sharedDir);
        if (spec) {
          spawnAgent(
            store,
            dataDir,
            spec.parentSandbox,
            {
              parentSessionKey: spec.parentSessionKey,
              task: spec.task,
              role: spec.role,
              teamId: agent.teamId,
            },
            sharedDir,
          );
          console.log(
            `[agents] team ${agent.teamId} settled via spawn failure — spawned follow-on ${spec.role}, deferring team-done`,
          );
        } else {
          crons.create({
            sessionKey: agent.parentSessionKey,
            systemEvent: teamCompletionMessage(agent.teamId, store),
            schedule: { kind: "once", atMs: Date.now() + 2000 },
          });
          crons.cancelPokes(agent.parentSessionKey);
          console.log(`[agents] team ${agent.teamId} settled via spawn failure, firing team-done`);
        }
      }
    } else {
      crons.create({
        sessionKey: agent.parentSessionKey,
        systemEvent: agentCompletionMessage(agent.id, agent.task, "failed", reason),
        schedule: { kind: "once", atMs: Date.now() + 2000 },
      });
      crons.cancelPokes(agent.parentSessionKey);
      console.log(`[agents] fired proactive delivery for spawn-failed ${agent.id}`);
    }
  } catch (err) {
    console.error(
      `[agents] spawn-failure notify error for ${agentId}: ${String(err).slice(0, 200)}`,
    );
  }
}
