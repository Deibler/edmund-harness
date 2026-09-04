import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { spawnAgent, spawnTeam } from "../../agents/spawn.ts";
import { AgentStore } from "../../agents/store.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

/**
 * Sub-agent orchestration exposed to Edmund. Typical flow:
 *
 *   User: "research X and give me the top 5 sources"
 *   Edmund: send_message("on it, give me a minute")
 *         → spawn_agent("research X and list top 5 sources")  → returns id
 *         → (turn ends, user waits a bit and sends another message)
 *   Edmund: list_agents(status="done") → finds id
 *         → read_agent_result(id) → reformat into iMessage reply
 *
 * Each sub-agent runs as a detached model CLI with full MCP access but a
 * worker system prompt (no Edmund persona). Sub-agents write their result
 * to a per-agent file in `<parent-sandbox>/agents/<id>/result.md`.
 */

const HandoffInput = z.object({
  work_done: z
    .string()
    .min(10)
    .describe(
      "What has already been completed or decided in this turn. The agent picks up exactly from here — be concrete.",
    ),
  work_remaining: z
    .string()
    .min(10)
    .describe(
      "What still needs to happen. This becomes the agent's primary objective. Include the expected deliverable shape.",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "Original user request, constraints, output format, or anything else the agent needs. Include what you'd normally put in a spawn_agent task string.",
    ),
});

const SpawnInput = z.object({
  task: z
    .string()
    .min(10)
    .describe(
      "The task the sub-agent should complete. Be specific — it has no context from this conversation beyond what you write. Include goal, constraints, and what the deliverable should look like (e.g. 'list of 5 links with one-sentence summaries').",
    ),
  role: z
    .string()
    .optional()
    .describe(
      "Optional role tag (e.g. 'researcher', 'summarizer'). Useful when tracking teams; ignore for one-offs.",
    ),
});

const ListInput = z.object({
  status: z
    .enum(["pending", "running", "done", "failed", "canceled"])
    .optional()
    .describe("Filter by status. Omit to list all agents for this conversation."),
});

const IdInput = z.object({
  id: z.string().describe("Agent id returned by spawn_agent."),
});

const TeamInput = z.object({
  members: z
    .array(
      z.object({
        role: z
          .string()
          .min(1)
          .describe("Short role name (e.g. 'scout', 'summarizer', 'verifier')."),
        task: z
          .string()
          .min(10)
          .describe(
            "Task for this member. Include goal, expected deliverable, and any handoff expectations. If this member reads from earlier members' output, mention the shared scratch dir and expected filenames.",
          ),
      }),
    )
    .min(1)
    .describe(
      "Array of roles. Members run concurrently by default; use task wording for handoff ordering.",
    ),
});

const TeamIdInput = z.object({
  team_id: z.string().describe("Team id returned by spawn_team."),
});

export function agentTools(ctx: ToolContext): ToolDef[] {
  const dataDir = ctx.dataDir;
  let store: AgentStore | null = null;
  const getStore = () => {
    if (!store) store = new AgentStore(dataDir);
    return store;
  };

  return [
    {
      name: "handoff_current_work",
      description:
        "Mid-task preemption: you're partway through a long job and need to free this turn NOW. Concrete trigger: check_incoming() shows a queued follow-up AND your remaining work is >30s — hand off instead of making the user wait behind it. Also right when you realize a task is much longer than expected. Package up what you've done + what remains into a sub-agent, then end your turn to handle the queued message or new request. The agent continues exactly where you left off; Edmund gets a wake-up event when it finishes (do NOT poll for it). Typical flow: handoff_current_work(done, remaining) → send_message(ack to queued msg) → end turn with brief note to user. The sub-agent has no conversation memory — put ALL needed context into work_done + work_remaining + context: exact file paths, URLs already fetched, decisions made, and the output format you promised.",
      inputSchema: HandoffInput,
      handler: async (args) => {
        const taskLines = [
          "HANDOFF CONTEXT",
          "===============",
          "",
          "Work already completed before this handoff:",
          args.work_done,
          "",
          "Your job — pick up from here and complete:",
          args.work_remaining,
        ];
        if (args.context) {
          taskLines.push("", "Additional context from the original request:", args.context);
        }
        taskLines.push(
          "",
          "When you finish, produce a clean result. The parent session (Edmund) will be notified and relay your output to the user.",
        );
        const agent = spawnAgent(getStore(), dataDir, ctx.sandboxPath, {
          parentSessionKey: ctx.sessionKey,
          task: taskLines.join("\n"),
          role: "handoff",
        });
        return text(
          [
            `handoff spawned: ${agent.id}`,
            `continuing: ${args.work_remaining.slice(0, 120)}`,
            ``,
            `Next: use send_message() to ack any queued follow-up, then end your turn.`,
            `Edmund wakes up when agent ${agent.id} finishes.`,
          ].join("\n"),
        );
      },
    },
    {
      name: "spawn_agent",
      description:
        "Fire off a sub-agent to do a long-running task in the background (research, deep summarization, multi-step analysis). Returns an agent id immediately — your turn stays responsive. The sub-agent has full MCP + skill access but no ability to text the user; it produces a result file you read later with `read_agent_result`. Use this when a task would blow past ~30 seconds of inline work or when you want to run multiple investigations in parallel. For quick lookups (one web fetch, one tool call), just do it inline.",
      inputSchema: SpawnInput,
      handler: async (args) => {
        const agent = spawnAgent(getStore(), dataDir, ctx.sandboxPath, {
          parentSessionKey: ctx.sessionKey,
          task: args.task,
          role: args.role,
        });
        return text(
          [
            `spawned ${agent.id}`,
            `status: ${agent.status}`,
            `task: ${agent.task}`,
            `result file: ${agent.resultPath}`,
            ``,
            `Do NOT poll — you'll be woken automatically with a completion event when it finishes. End your turn; read final output then with read_agent_result(${agent.id}). check_agent is only for when the user asks for a progress peek.`,
          ].join("\n"),
        );
      },
    },
    {
      name: "list_agents",
      description:
        "List sub-agents spawned in THIS conversation (most recent first). Shows id, status, task, role, age. Call at the start of a turn when the user asks 'is it done yet?' or you suspect prior work completed.",
      inputSchema: ListInput,
      handler: async (args) => {
        const agents = getStore().list({
          parentSessionKey: ctx.sessionKey,
          status: args.status,
        });
        if (agents.length === 0) return text("no sub-agents for this conversation");
        const lines = agents.slice(0, 20).map((a) => {
          const age = humanAge(Date.now() - a.spawnedAt);
          const role = a.role ? ` role=${a.role}` : "";
          const team = a.teamId ? ` team=${a.teamId}` : "";
          return `• ${a.id} [${a.status}]${role}${team} ${age} ago — ${a.task.slice(0, 80)}`;
        });
        return text(lines.join("\n"));
      },
    },
    {
      name: "check_agent",
      description:
        "Get current status + last 1000 chars of the agent's log. Use to see if it's still making progress or stuck. Doesn't return the final result — use read_agent_result for that.",
      inputSchema: IdInput,
      handler: async (args) => {
        const agent = getStore().get(args.id);
        if (!agent) return text(`no such agent: ${args.id}`, true);
        if (agent.parentSessionKey !== ctx.sessionKey) {
          return text(`agent ${args.id} belongs to a different conversation`, true);
        }
        const tail = readTail(agent.logPath, 1000);
        const age = humanAge(Date.now() - agent.spawnedAt);
        return text(
          [
            `id: ${agent.id}`,
            `status: ${agent.status}${agent.exitCode !== null ? ` exit=${agent.exitCode}` : ""}`,
            `task: ${agent.task}`,
            `age: ${age}`,
            agent.finishedAt
              ? `finished: ${humanAge(Date.now() - agent.finishedAt)} ago`
              : `running (pid ${agent.pid ?? "?"})`,
            ``,
            `--- log tail ---`,
            tail,
          ].join("\n"),
        );
      },
    },
    {
      name: "read_agent_result",
      description:
        "Read the output of a finished sub-agent (status=done or failed). Errors if still pending/running. Failed agents may have partial output — still worth reading. The result is the agent's final assistant text — reformat it for the user; don't paste it raw.",
      inputSchema: IdInput,
      handler: async (args) => {
        const agent = getStore().get(args.id);
        if (!agent) return text(`no such agent: ${args.id}`, true);
        if (agent.parentSessionKey !== ctx.sessionKey) {
          return text(`agent ${args.id} belongs to a different conversation`, true);
        }
        if (agent.status === "pending" || agent.status === "running") {
          return text(`agent ${args.id} is still ${agent.status}; result not ready yet`, true);
        }
        if (!existsSync(agent.resultPath)) {
          return text(
            `agent ${args.id} finished (${agent.status}) but result file missing at ${agent.resultPath}`,
            true,
          );
        }
        const body = readFileSync(agent.resultPath, "utf8");
        getStore().markDelivered(agent.id);
        const prefix =
          agent.status === "failed" ? "[agent failed — output below may be partial]\n\n" : "";
        return text(`${prefix}${body}`);
      },
    },
    {
      name: "cancel_agent",
      description:
        "Kill a running sub-agent. Use when the task is no longer needed or the agent is clearly stuck.",
      inputSchema: IdInput,
      handler: async (args) => {
        const agent = getStore().get(args.id);
        if (!agent) return text(`no such agent: ${args.id}`, true);
        if (agent.parentSessionKey !== ctx.sessionKey) {
          return text(`agent ${args.id} belongs to a different conversation`, true);
        }
        if (agent.status !== "running" && agent.status !== "pending") {
          return text(`agent ${args.id} is ${agent.status}; nothing to cancel`);
        }
        if (agent.pid) {
          try {
            process.kill(agent.pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
        getStore().finish(agent.id, "canceled", null);
        return text(`canceled ${args.id}`);
      },
    },
    {
      name: "spawn_team",
      description:
        "Fire off a coordinated team of sub-agents. Use for multi-stage pipelines (scout + summarize + verify), parallel investigations, or when each step needs a different lens. Members share a scratch directory for handoffs. When ALL members finish, Edmund gets ONE wake-up event (not one per member). If a role's task depends on another role's output, state that in its task string and reference the shared scratch dir. See `skills/teams/` for pre-shaped team patterns.",
      inputSchema: TeamInput,
      handler: async (args) => {
        const result = spawnTeam(
          getStore(),
          dataDir,
          ctx.sandboxPath,
          ctx.sessionKey,
          args.members,
        );
        const lines = [
          `spawned team ${result.teamId} with ${result.agents.length} members:`,
          ...result.agents.map((a) => `  - ${a.role ?? "member"} → ${a.id}`),
          ``,
          `shared scratch: ${result.sharedDir}`,
          ``,
          `Do NOT poll — when all members settle you'll be woken with ONE team-done event. End your turn; read results then with read_team_results. list_team is only for when the user asks for a progress peek.`,
        ];
        return text(lines.join("\n"));
      },
    },
    {
      name: "list_team",
      description:
        "Show the status of every member in a team. Use to see progress when the user asks 'is my research done yet?'.",
      inputSchema: TeamIdInput,
      handler: async (args) => {
        const members = getStore().listTeam(args.team_id);
        if (members.length === 0) return text(`no such team: ${args.team_id}`, true);
        if (members[0]!.parentSessionKey !== ctx.sessionKey) {
          return text(`team ${args.team_id} belongs to a different conversation`, true);
        }
        const lines = members.map((m) => {
          const age = humanAge(Date.now() - m.spawnedAt);
          const exit = m.exitCode !== null ? ` exit=${m.exitCode}` : "";
          return `  ${m.role ?? "member"} [${m.status}${exit}] ${age} — ${m.task.slice(0, 80)}`;
        });
        return text([`team ${args.team_id}:`, ...lines].join("\n"));
      },
    },
    {
      name: "read_team_results",
      description:
        "Read all members' results at once. Returns role -> result text. Works even if only some members are done (missing members noted inline). Synthesize into one reply to the user; don't paste raw output.",
      inputSchema: TeamIdInput,
      handler: async (args) => {
        const members = getStore().listTeam(args.team_id);
        if (members.length === 0) return text(`no such team: ${args.team_id}`, true);
        if (members[0]!.parentSessionKey !== ctx.sessionKey) {
          return text(`team ${args.team_id} belongs to a different conversation`, true);
        }
        const sections = members.map((m) => {
          const header = `=== ${m.role ?? "member"} (${m.id}) [${m.status}] ===`;
          if (m.status === "pending" || m.status === "running")
            return `${header}\n(not yet complete)`;
          const body = existsSync(m.resultPath)
            ? readFileSync(m.resultPath, "utf8")
            : "(result file missing)";
          const note =
            m.status === "failed" ? "[agent failed — output below may be partial]\n\n" : "";
          return `${header}\n${note}${body}`;
        });
        // Mark all as delivered on full read so Edmund doesn't re-relay later.
        for (const m of members)
          if (m.status === "done" && !m.deliveredAt) getStore().markDelivered(m.id);
        return text(sections.join("\n\n"));
      },
    },
    {
      name: "cancel_team",
      description: "Kill every running member of a team. Use when the collective work is obsolete.",
      inputSchema: TeamIdInput,
      handler: async (args) => {
        const members = getStore().listTeam(args.team_id);
        if (members.length === 0) return text(`no such team: ${args.team_id}`, true);
        if (members[0]!.parentSessionKey !== ctx.sessionKey) {
          return text(`team ${args.team_id} belongs to a different conversation`, true);
        }
        let killed = 0;
        for (const m of members) {
          if (m.status !== "running" && m.status !== "pending") continue;
          if (m.pid) {
            try {
              process.kill(m.pid, "SIGTERM");
            } catch {}
          }
          getStore().finish(m.id, "canceled", null);
          killed++;
        }
        return text(`canceled ${killed} member(s) of team ${args.team_id}`);
      },
    },
  ];
}

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

function readTail(path: string, bytes: number): string {
  if (!existsSync(path)) return "(no log yet)";
  const full = readFileSync(path, "utf8");
  return full.length > bytes ? `...${full.slice(-bytes)}` : full;
}

function humanAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
