import { spawn } from "node:child_process";
import { directClaudeEnv } from "../claude/direct-env.ts";
import { type OneShotResult, runClaudeOneShot } from "../claude/one-shot.ts";
import { buildCodexExecArgs, codexExecutable, parseCodexJsonLine } from "../codex/runner.ts";
import { log } from "../util/log.ts";
import { backendForModel } from "./backend.ts";
import type { ModelEffort } from "./profile.ts";

export type ModelOneShotInput = {
  /** Existing Claude-style args; common model/prompt/MCP flags are translated for Codex. */
  args: string[];
  input: string;
  timeoutMs: number;
  env?: Record<string, string>;
  cwd?: string;
};

/** Route satellite model calls through the same model-name convention as turns. */
export function runModelOneShot(opts: ModelOneShotInput): Promise<OneShotResult> {
  const model = argValue(opts.args, "--model") ?? "";
  if (backendForModel(model) === "claude") return runClaudeOneShot(opts);
  return runCodexOneShot(opts, model);
}

function runCodexOneShot(opts: ModelOneShotInput, model: string): Promise<OneShotResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const systemPrompt = argValue(opts.args, "--append-system-prompt") ?? "";
    const mcpConfig = argValue(opts.args, "--mcp-config") ?? '{"mcpServers":{}}';
    const hasMcp = mcpConfig !== '{"mcpServers":{}}';
    const effort = parseEffort(argValue(opts.args, "--effort") ?? process.env.EDMUND_EFFORT);
    let args: string[];
    let executable: string;
    try {
      executable = codexExecutable();
      args = buildCodexExecArgs({
        model,
        effort,
        contextWindowTokens: positiveInt(process.env.EDMUND_CONTEXT_WINDOW_TOKENS),
        systemPrompt,
        mcpConfig,
        // Structured/judge calls need no filesystem. Tool-using ghost calls
        // carry an MCP config and retain the normal workspace sandbox.
        guest: !hasMcp,
        ephemeral: true,
      });
    } catch (err) {
      resolve(failedResult((err as Error).message, null, "", startedAt, model));
      return;
    }

    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...directClaudeEnv(), ...(opts.env ?? {}) },
      cwd: opts.cwd,
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let text = "";
    let usage: OneShotResult["usage"] = null;
    let eventError: string | null = null;
    let settled = false;

    const settle = (error: string | null, status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      const finalError = error ?? eventError;
      const failed = finalError !== null || status !== 0 || text.trim().length === 0;
      resolve({
        ok: !failed,
        text: text.trim(),
        error: failed
          ? (finalError ??
            (status !== 0
              ? `codex exited ${status}: ${stderr.slice(0, 200)}`
              : "codex produced no output"))
          : null,
        status,
        stderr,
        costUsd: null,
        usage,
        model,
        numTurns: 1,
        durationMs: Date.now() - startedAt,
      });
    };

    const consume = (line: string) => {
      const event = parseCodexJsonLine(line);
      if (!event) return;
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        if (typeof event.item.text === "string") text = event.item.text;
      } else if (event.type === "turn.completed") {
        usage = {
          input_tokens: event.usage?.input_tokens,
          output_tokens: event.usage?.output_tokens,
          cache_read_input_tokens: event.usage?.cached_input_tokens,
          cache_creation_input_tokens: event.usage?.cache_write_input_tokens,
        };
        // The turn finished: any earlier `error` event was a transient the
        // CLI recovered from (stream reconnects), not a verdict on this run.
        eventError = null;
      } else if (event.type === "turn.failed") {
        eventError =
          typeof event.error === "string"
            ? event.error
            : (event.error?.message ?? event.message ?? "codex returned error");
      } else if (event.type === "error") {
        // Non-terminal — the CLI is retrying. Only counts if nothing
        // completes afterwards.
        eventError =
          typeof event.error === "string"
            ? event.error
            : (event.error?.message ?? event.message ?? "codex stream error");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      let newline = stdout.indexOf("\n");
      while (newline !== -1) {
        consume(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => settle(err.message, null));
    child.on("close", (code) => {
      if (stdout.trim()) consume(stdout);
      settle(null, code);
    });
    child.stdin.end(opts.input);

    const killer = setTimeout(() => {
      terminateProcessTree(child.pid, "SIGTERM");
      setTimeout(() => terminateProcessTree(child.pid, "SIGKILL"), 2_000).unref?.();
      settle(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`, null);
    }, opts.timeoutMs);
  });
}

function argValue(args: string[], flag: string): string | null {
  const index = args.lastIndexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function parseEffort(value: string | undefined): ModelEffort {
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

function failedResult(
  error: string,
  status: number | null,
  stderr: string,
  startedAt: number,
  model: string,
): OneShotResult {
  return {
    ok: false,
    text: "",
    error,
    status,
    stderr,
    costUsd: null,
    usage: null,
    model,
    numTurns: null,
    durationMs: Date.now() - startedAt,
  };
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch (err) {
      log.debug("one-shot", "process already exited", { err: (err as Error).message });
    }
  }
}
