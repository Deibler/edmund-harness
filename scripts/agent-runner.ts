#!/usr/bin/env bun
/**
 * Worker that wraps a single sub-agent model invocation.
 *
 * Args (via env, since we launch detached):
 *   AGENT_ID, AGENT_TASK, AGENT_SANDBOX, AGENT_RESULT, AGENT_LOG,
 *   EDMUND_DATA_DIR (for agents.db + mcp.json)
 *
 * Lifecycle:
 *   1. Claim the agents row (pending → running, pid=self). A row already
 *      settled (the reaper gave up on a slow start, or a cancel) exits here.
 *   2. Spawn the CLI selected by EDMUND_AGENT_MODEL with the task as user
 *      prompt and a focused system prompt (no iMessage persona — the agent
 *      is a worker, not Edmund).
 *   3. Stream stdout to log; capture the final assistant text; stamp a
 *      heartbeat on the row so the reaper can tell quiet from working.
 *   4. Write final text to the result file.
 *   5. Settle the row (status=done|failed) and, if this runner settled it,
 *      wake the parent. SIGTERM (reaper, cancel) writes what the agent had so
 *      far as a partial result instead.
 *
 * The parent Edmund process polls agents.db via list_agents / check_agent
 * / read_agent_result to see progress and surface results to the user.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configuredAgentModel, notifyParent } from "../src/agents/spawn.ts";
import { AgentStore } from "../src/agents/store.ts";
import { ISOLATED_SETTINGS_ARGS, directClaudeEnv } from "../src/claude/direct-env.ts";
import { buildCodexExecArgs, codexExecutable, parseCodexJsonLine } from "../src/codex/runner.ts";
import { CronStore } from "../src/cron/store.ts";
import { backendForModel } from "../src/model/backend.ts";
import type { ModelEffort } from "../src/model/profile.ts";
import {
  type HostAccess,
  disallowedBuiltinTools,
  pluginDirArgs,
  pluginDirsFromEnv,
} from "../src/security/policy.ts";
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
if (!store.claimRunning(id, process.pid)) {
  log.info("agent", "row already settled before start; not running", { id });
  process.exit(0);
}

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

const model = configuredAgentModel();
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
        ...ISOLATED_SETTINGS_ARGS,
        ...pluginDirArgs(
          pluginDirsFromEnv(process.env.EDMUND_PLUGIN_DIRS),
          hostAccessFromEnv,
          false,
        ),
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
// Liveness for the reaper: any CLI output counts. One write per interval.
const HEARTBEAT_EVERY_MS = 10_000;
let lastHeartbeatMs = 0;
const heartbeat = (): void => {
  const now = Date.now();
  if (now - lastHeartbeatMs < HEARTBEAT_EVERY_MS) return;
  lastHeartbeatMs = now;
  try {
    store.heartbeat(id, now);
  } catch (err) {
    appendLog(`[agent-runner] heartbeat error: ${String(err).slice(0, 200)}`);
  }
};
// Set when SIGTERM arrives, so the CLI's exit that follows is not reported
// as an ordinary finish.
let stopping = false;
proc.stdout.on("data", (chunk: Buffer) => {
  heartbeat();
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

proc.stderr.on("data", (c: Buffer) => {
  heartbeat();
  appendLog(`[stderr] ${c.toString("utf8").trim()}`);
});

// The reaper and the cancel tools SIGTERM this runner's process group. Bun's
// default was to die on the spot, so no result file was written and whatever
// the agent had found was lost. Keep it, say why it stopped, and stop the
// CLI. Whoever sent the signal settled the row first and tells the parent;
// a signal from anywhere else (a shutdown) settles it here.
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  const row = store.get(id);
  const why = row?.stopReason ?? "stopped by a signal before it finished";
  const partial = lastAssistantText.trim();
  writeFileSync(
    resultPath,
    `${partial ? `${partial}\n\n` : ""}(The agent was ${why}. ${partial ? "What is above is its last output, and may be partial." : "It produced no text before it stopped."})`,
  );
  appendLog(`[agent-runner] SIGTERM: ${why}; wrote partial result (${partial.length} chars)`);
  try {
    proc.kill("SIGTERM");
  } catch {}
  if (store.finishIfActive(id, "failed", null, why)) {
    const settled = store.get(id);
    if (settled) {
      notifyParent({ store, crons: new CronStore(dataDir), dataDir, agent: settled, note: why });
    }
  }
  logStream.end();
  process.exit(143);
});

proc.on("exit", (code) => {
  if (stopping) return;
  const raw = lastAssistantText.trim();
  const modelUnavailable = MODEL_UNAVAILABLE.test(raw);
  const text = modelUnavailable
    ? `This sub-agent could not start: the configured agent model (${model}) is unavailable to the CLI, which said: "${raw}". Spawning another agent will fail the same way. Do the work yourself, and tell the operator to fix [claude].agent_model in config.toml.`
    : raw || "(agent produced no final text)";
  writeFileSync(resultPath, text);
  const status = code === 0 ? "done" : "failed";
  const settledHere = store.finishIfActive(
    id,
    status,
    code,
    modelUnavailable ? `agent model ${model} is unavailable` : null,
  );
  appendLog(
    `[agent-runner] exit code=${code} status=${status} result_chars=${text.length}${reportedCostUsd !== null ? ` cost_usd=${reportedCostUsd.toFixed(4)}` : ""}${settledHere ? "" : " (already settled elsewhere)"}`,
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

  // Proactive delivery: wake the parent so Edmund relays the result. Only
  // the runner that settled the row reports it (the reaper or a cancel may
  // have got there first), and a team reports once, when it has settled.
  if (settledHere) {
    const agent = store.get(id);
    if (agent) {
      notifyParent({
        store,
        crons: new CronStore(dataDir),
        dataDir,
        agent,
        note: modelUnavailable ? `the configured agent model (${model}) is unavailable` : undefined,
        log: (line) => appendLog(`[agent-runner] ${line}`),
      });
    }
  }

  logStream.end();
  process.exit(code ?? 1);
});

/** What the CLI prints when the model it was given does not exist or is not
 *  available to this account. Ten agents failed this way. */
const MODEL_UNAVAILABLE = /There's an issue with the selected model/;

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
