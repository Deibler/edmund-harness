#!/usr/bin/env bun
/**
 * Worker that wraps a single sub-agent model invocation.
 *
 * Args (via env, since we launch detached):
 *   AGENT_ID, AGENT_TASK, AGENT_SANDBOX, AGENT_RESULT, AGENT_LOG,
 *   EDMUND_DATA_DIR (for agents.db + mcp.json)
 *
 * Lifecycle:
 *   1. Update agents row → status=running, pid=self
 *   2. Spawn the CLI selected by EDMUND_AGENT_MODEL with the task as user
 *      prompt and a focused system prompt (no iMessage persona — the agent
 *      is a worker, not Edmund).
 *   3. Stream stdout to log; capture the final assistant text.
 *   4. Write final text to the result file.
 *   5. Update agents row → status=done|failed, exit_code, finished_at.
 *
 * The parent Edmund process polls agents.db via list_agents / check_agent
 * / read_agent_result to see progress and surface results to the user.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { consumeFollowOnMarker, teamSharedDirFor } from "../src/agents/follow-on.ts";
import { agentCompletionMessage, teamCompletionMessage } from "../src/agents/messages.ts";
import { spawnAgent } from "../src/agents/spawn.ts";
import { AgentStore } from "../src/agents/store.ts";
import { directClaudeEnv } from "../src/claude/direct-env.ts";
import { buildCodexExecArgs, codexExecutable, parseCodexJsonLine } from "../src/codex/runner.ts";
import { CronStore } from "../src/cron/store.ts";
import { backendForModel } from "../src/model/backend.ts";
import type { ModelEffort } from "../src/model/profile.ts";
import { type HostAccess, disallowedBuiltinTools } from "../src/security/policy.ts";
import { recordSpend } from "../src/spend/ledger.ts";
import { installLogSinkFromEnv } from "../src/util/log-sink.ts";
import { log } from "../src/util/log.ts";

const id = must("AGENT_ID");
const task = must("AGENT_TASK");
const sandbox = must("AGENT_SANDBOX");
const resultPath = must("AGENT_RESULT");
const logPath = must("AGENT_LOG");
const dataDir = must("EDMUND_DATA_DIR");

// Mirror this subprocess's console output into daemon.log so agent
// lifecycle shows up in the shared audit trail (the per-agent agent.log
// still captures the full stream; this just surfaces lifecycle hits).
installLogSinkFromEnv(`agent[${id}] `);
log.info("agent", "runner starting", { id, task: task.slice(0, 120) });

const store = new AgentStore(dataDir);
store.setRunning(id, process.pid);

// Trading sub-agents load the trading MCP config (Robinhood tools) so they can
// research with live market data — but they are forbidden from placing orders
// (see the preamble below); execution stays in the parent trading session.
const isTrading = process.env.EDMUND_TRADING === "1";
const mcpConfig = join(dataDir, isTrading ? "mcp-trading.json" : "mcp.json");
const teamShared = process.env.AGENT_TEAM_SHARED;
const teamId = process.env.AGENT_TEAM_ID;
const role = process.env.AGENT_ROLE;

const teamLines = teamShared
  ? [
      ``,
      `You are part of an agent team (team_id: ${teamId}, role: ${role ?? "member"}).`,
      `Team shared scratch: ${teamShared}`,
      `- READ from ${teamShared} at startup to pick up work other members have already deposited.`,
      `- WRITE intermediate deliverables there (e.g. \`${teamShared}/scout-links.json\`) so downstream teammates can consume them.`,
      `- Name files by role so readers know what's what (\`<role>-<artifact>.<ext>\`).`,
      `- Don't poll: do your part, drop your output in shared, produce your final text, exit.`,
    ]
  : [];

const tradingLines = isTrading
  ? [
      ``,
      `You are a RESEARCH sub-agent for an autonomous Robinhood trading bot.`,
      `You have read access to Robinhood market data and the web. Your job is to`,
      `research and RECOMMEND — gather data, analyze, and produce a clear thesis.`,
      `You must NEVER place, modify, or cancel any order, and never call`,
      `place_equity_order / cancel_equity_order. All execution happens in the`,
      `parent trading session through its risk-checked path. If your analysis`,
      `suggests a trade, state it as a recommendation (symbol, side, size rationale,`,
      `entry/exit logic) for the parent to risk-check and place.`,
    ]
  : [];

const systemPrompt = [
  `You are a sub-agent working on behalf of Edmund's iMessage assistant.`,
  `You are NOT Edmund and NOT talking to a user directly; your parent will relay results.`,
  ...tradingLines,
  ``,
  `Task:`,
  task,
  ``,
  `Your scratch workspace: ${sandbox}`,
  ...teamLines,
  ``,
  "Instructions:",
  "- Do the task in as few steps as possible. Use skills when relevant (call list_skills).",
  "- The send_message and send_attachment tools will not reach the user from here; don't call them. Produce your output as your final assistant text. It will be written to your result file and returned to the parent.",
  `- Be concise. Your final text IS the deliverable. If the task is "summarize X", reply with the summary. If it's "research X and list sources", reply with the list.`,
  "- If the task is impossible or needs clarification, say so in your final text. Don't loop on dead ends.",
].join("\n");

const logStream = Bun.file(logPath).writer();
const appendLog = (line: string): void => {
  logStream.write(`${new Date().toISOString()} ${line}\n`);
  logStream.flush();
};

appendLog(`[agent-runner] id=${id} pid=${process.pid} starting`);

const model = process.env.EDMUND_AGENT_MODEL ?? "claude-sonnet-5";
const effort = modelEffort(process.env.EDMUND_AGENT_EFFORT ?? process.env.EDMUND_EFFORT);
const backend = backendForModel(model);
const hostAccessFromEnv: HostAccess =
  process.env.EDMUND_HOST_ACCESS === "full" ? "full" : "sandboxed";
const args =
  backend === "codex"
    ? buildCodexExecArgs({
        model,
        effort,
        contextWindowTokens: positiveInt(process.env.EDMUND_CONTEXT_WINDOW_TOKENS),
        systemPrompt,
        mcpConfig,
        guest: false,
        sandboxed: hostAccessFromEnv === "sandboxed",
        ephemeral: true,
        additionalWritableDirs: teamShared ? [resolve(teamShared)] : [],
      })
    : [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "text",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        // Same host-access policy as the parent worker: the daemon put the
        // mode in the environment the MCP server (which spawned us) inherits.
        "--disallowedTools",
        disallowedBuiltinTools(hostAccessFromEnv, false),
        "--model",
        model,
        "--effort",
        effort,
        "--mcp-config",
        mcpConfig,
        // Only the file's servers — don't inherit user/project MCP servers.
        "--strict-mcp-config",
        "--append-system-prompt",
        systemPrompt,
      ];

const proc = spawn(backend === "codex" ? codexExecutable() : "claude", args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...directClaudeEnv(),
    EDMUND_SESSION_KEY: `agent:${id}`,
    EDMUND_SANDBOX_PATH: resolve(sandbox),
  },
  cwd: resolve(sandbox),
});

proc.stdin.write(task);
proc.stdin.end();

let lastAssistantText = "";
let stdoutBuf = "";
let reportedCostUsd: number | null = null;
const runnerStartedAt = Date.now();
proc.stdout.on("data", (chunk: Buffer) => {
  stdoutBuf += chunk.toString("utf8");
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    appendLog(`[stream] ${line.slice(0, 500)}`);
    try {
      const evt = JSON.parse(line) as StreamEvent;
      if (evt.type === "assistant" && evt.message?.content) {
        for (const part of evt.message.content) {
          if (part.type === "text" && typeof part.text === "string") {
            lastAssistantText = part.text;
          }
        }
      } else if (evt.type === "result") {
        if (typeof evt.result === "string") lastAssistantText = evt.result;
        if (typeof evt.total_cost_usd === "number") reportedCostUsd = evt.total_cost_usd;
      } else {
        const codexEvent = parseCodexJsonLine(line);
        if (
          codexEvent?.type === "item.completed" &&
          codexEvent.item?.type === "agent_message" &&
          typeof codexEvent.item.text === "string"
        ) {
          lastAssistantText = codexEvent.item.text;
        }
      }
    } catch {
      // non-JSON line; already logged
    }
  }
});

proc.stderr.on("data", (c: Buffer) => appendLog(`[stderr] ${c.toString("utf8").trim()}`));

proc.on("exit", (code) => {
  const text = lastAssistantText.trim() || "(agent produced no final text)";
  writeFileSync(resultPath, text);
  const status = code === 0 ? "done" : "failed";
  store.finish(id, status, code);
  appendLog(
    `[agent-runner] exit code=${code} status=${status} result_chars=${text.length}${reportedCostUsd !== null ? ` cost_usd=${reportedCostUsd.toFixed(4)}` : ""}`,
  );
  // Spend accounting: persist the CLI-reported cost on the agent row and
  // ledger it against the PARENT session (that's the conversation that
  // asked for this work).
  try {
    if (reportedCostUsd !== null) store.setCostUsd(id, reportedCostUsd);
    const agentRow = store.get(id);
    if (agentRow) {
      recordSpend(dataDir, {
        sessionKey: agentRow.parentSessionKey,
        subsystem: "agent",
        model,
        costUsd: reportedCostUsd,
        durMs: Date.now() - runnerStartedAt,
      });
    }
  } catch (err) {
    appendLog(`[agent-runner] spend accounting error: ${String(err).slice(0, 200)}`);
  }

  // Proactive delivery: fire a one-shot cron event so Edmund wakes up in
  // the parent session and relays the result. For team members, only fire
  // once when the final member settles — otherwise a 3-member team would
  // wake Edmund 3 times instead of once.
  try {
    const agent = store.get(id);
    if (agent) {
      const crons = new CronStore(dataDir);
      if (agent.teamId) {
        // Sweep zombies: members stuck in pending/running past a reasonable
        // threshold (e.g., spawn silently failed, or runner crashed before
        // setRunning). Without this, one zombie blocks the whole team from
        // ever notifying the parent.
        // pendingStaleMs matches spawn.ts / wire-recovery.ts (60s) — the
        // old 10s value here could reap a healthy sibling whose bun +
        // claude cold start ran long on a loaded machine.
        const reaped = store.teamReapZombies(agent.teamId, {
          pendingStaleMs: 60_000,
          runningStaleMs: 15 * 60 * 1000,
        });
        if (reaped > 0) {
          appendLog(`[agent-runner] reaped ${reaped} zombie teammate(s) in ${agent.teamId}`);
        }
        if (store.teamFullySettled(agent.teamId)) {
          // Follow-on marker (deep_research's synthesizer): spawn it now
          // that the fan-out has settled — it joins the same team, so the
          // team-done event fires when IT finishes. Atomic consume means
          // exactly one settling member wins even in a photo finish.
          const sharedDir =
            process.env.AGENT_TEAM_SHARED ?? teamSharedDirFor(agent.sandboxPath, agent.teamId);
          const spec = consumeFollowOnMarker(sharedDir);
          if (spec) {
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
            appendLog(
              `[agent-runner] team ${agent.teamId} fan-out settled — spawned follow-on ${spec.role} (${followOn.id}), deferring team-done`,
            );
          } else {
            crons.create({
              sessionKey: agent.parentSessionKey,
              systemEvent: teamCompletionMessage(agent.teamId, store),
              schedule: { kind: "once", atMs: Date.now() + 2000 },
            });
            const canceledPokes = crons.cancelPokes(agent.parentSessionKey);
            appendLog(
              `[agent-runner] team ${agent.teamId} fully settled, firing team-done event (canceled ${canceledPokes} stale poke(s))`,
            );
          }
        } else {
          appendLog(
            `[agent-runner] team ${agent.teamId} still has in-flight members, skipping fire`,
          );
        }
      } else {
        crons.create({
          sessionKey: agent.parentSessionKey,
          systemEvent: agentCompletionMessage(agent.id, agent.task, status),
          schedule: { kind: "once", atMs: Date.now() + 2000 },
        });
        const canceledPokes = crons.cancelPokes(agent.parentSessionKey);
        appendLog(
          `[agent-runner] fired proactive delivery for ${agent.id} (canceled ${canceledPokes} stale poke(s))`,
        );
      }
    }
  } catch (err) {
    appendLog(`[agent-runner] proactive-delivery error: ${String(err).slice(0, 200)}`);
  }

  logStream.end();
  process.exit(code ?? 1);
});

function modelEffort(value: string | undefined): ModelEffort {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : "medium";
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

type StreamEvent = {
  type: "assistant" | "user" | "system" | "result" | string;
  message?: { content?: Array<{ type: string; text?: string }> };
  result?: string;
  total_cost_usd?: number;
};

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[agent-runner] missing env: ${name}`);
    process.exit(2);
  }
  return v;
}
