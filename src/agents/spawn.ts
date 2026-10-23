import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { directClaudeEnv } from "../claude/direct-env.ts";
import { CronStore } from "../cron/store.ts";
import { isTradingSession } from "../sessions/key.ts";
import { genId } from "../util/ids.ts";
import { consumeFollowOnMarker, teamSharedDirFor } from "./follow-on.ts";
import {
  agentCompletionMessage,
  queueCompletionWakeUp,
  teamCompletionMessage,
} from "./messages.ts";
import type { AgentStore } from "./store.ts";
import type { Agent, AgentInput } from "./types.ts";

/** A member that never claimed `running` after this long had a spawn failure.
 *  60s, not 10: bun + CLI cold start runs long on a loaded machine. */
export const PENDING_STALE_MS = 60_000;

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
  const model = configuredAgentModel();
  const problem = agentModelProblem(model);
  if (problem) {
    throw new Error(
      `sub-agents can't start: [claude].agent_model is "${model}" and ${problem}. Do this work yourself in this turn, and tell the operator to fix agent_model in config.toml.`,
    );
  }
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
 * Mark an agent failed AND wake the parent, so Edmund hears about the dead
 * agent instead of silently losing track of it. Spawn failures used to mark
 * the row and never notify: the parent waited for a result that never came.
 */
function markFailedAndNotify(
  store: AgentStore,
  dataDir: string,
  agentId: string,
  reason: string,
): void {
  try {
    if (!store.finishIfActive(agentId, "failed", null, reason)) return;
  } catch (dbErr) {
    console.error(`[agents] failed to mark ${agentId} as failed: ${String(dbErr)}`);
    return;
  }
  const agent = store.get(agentId);
  if (!agent) return;
  notifyParent({ store, crons: new CronStore(dataDir), dataDir, agent, note: reason });
}

/**
 * Tell the parent session an agent settled. Call only after winning
 * `finishIfActive`, so each agent is reported once whichever path settled
 * it (the runner's exit or SIGTERM, the reaper, a spawn failure).
 *
 * A solo agent queues a completion wake-up. A team member settles quietly
 * until the whole team has; then a follow-on marker (deep_research's
 * synthesizer) spawns the next stage, or the one team-done event goes out.
 */
export function notifyParent(args: {
  store: AgentStore;
  crons: Pick<CronStore, "coalesceOnce" | "cancelPokes">;
  dataDir: string;
  agent: Agent;
  note?: string;
  log?: (line: string) => void;
}): void {
  const { store, crons, dataDir, agent } = args;
  const say = args.log ?? ((line: string) => console.log(`[agents] ${line}`));
  try {
    if (!agent.teamId) {
      const pokes = queueCompletionWakeUp(
        crons,
        agent.parentSessionKey,
        agentCompletionMessage(agent.id, agent.task, agent.status, args.note),
      );
      say(`queued completion wake-up for ${agent.id} (canceled ${pokes} stale poke(s))`);
      return;
    }
    const failed = store.failStalePending(agent.teamId, PENDING_STALE_MS);
    if (failed > 0) say(`team ${agent.teamId}: ${failed} member(s) never started, marked failed`);
    if (!store.teamFullySettled(agent.teamId)) {
      say(`team ${agent.teamId} still has members in flight`);
      return;
    }
    const sharedDir = teamSharedDirFor(agent.sandboxPath, agent.teamId);
    const spec = consumeFollowOnMarker(sharedDir);
    if (spec) {
      try {
        const followOn = spawnAgent(
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
        say(`team ${agent.teamId} settled; spawned follow-on ${spec.role} (${followOn.id})`);
        return;
      } catch (err) {
        // The team is still done; report what it has rather than hang.
        say(`team ${agent.teamId}: follow-on ${spec.role} failed to spawn: ${String(err)}`);
      }
    }
    if (!store.claimTeamDone(agent.teamId)) return;
    const pokes = queueCompletionWakeUp(
      crons,
      agent.parentSessionKey,
      teamCompletionMessage(agent.teamId, store),
    );
    say(`team ${agent.teamId} settled; queued team-done (canceled ${pokes} stale poke(s))`);
  } catch (err) {
    console.error(`[agents] notify error for ${agent.id}: ${String(err).slice(0, 200)}`);
  }
}

/**
 * Stop an agent's runner and its CLI. The runner is spawned detached, so it
 * leads its own process group and the CLI is in it; signalling the pid alone
 * (what cancel did) left the CLI running. Falls back to the pid for a runner
 * that is not a group leader.
 */
export function killAgentProcess(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

/**
 * Why a configured sub-agent model cannot work, before any agent is spawned.
 * Ten agents failed at start on a bad agent_model, among them the dotted
 * "claude-sonnet-5.5": every spawn failed the same way and the parent only
 * learned from each failure in turn. Availability is the CLI's to judge (the
 * runner reports that); this catches what is wrong on its face.
 */
export function agentModelProblem(model: string): string | null {
  const name = model.trim();
  if (!name) return "it is empty";
  if (/\s/.test(name)) return "it contains whitespace";
  if (/^claude-.*\d\.\d/.test(name)) {
    return `Claude model ids use hyphens between version numbers ("${name.replace(/(\d)\.(\d)/g, "$1-$2")}")`;
  }
  return null;
}

/** The model a sub-agent runs on: [claude].agent_model, via the tool env. */
export function configuredAgentModel(): string {
  return process.env.EDMUND_AGENT_MODEL ?? DEFAULT_AGENT_MODEL;
}

export const DEFAULT_AGENT_MODEL = "claude-sonnet-5";
