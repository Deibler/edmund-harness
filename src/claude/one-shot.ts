import { spawn } from "node:child_process";
import { log } from "../util/log.ts";
import { directClaudeEnv } from "./direct-env.ts";

/**
 * Shared one-shot `claude -p` runner for the harness's satellite model
 * calls (ghost ticks, persona maintainer, catch-up summarizer, research
 * planner, ghost pre-screen).
 *
 * Why it exists:
 *   - Every satellite used `--output-format text`, which discards the CLI's
 *     result event — the only place `total_cost_usd` lives. All of them
 *     were invisible to spend accounting. This runner speaks stream-json
 *     and hands cost/usage/model back to the caller for the ledger.
 *   - Two of them used spawnSync, freezing their host process's event loop
 *     for the whole call. This is async with SIGTERM→SIGKILL teardown.
 *
 * The runner owns `-p --output-format stream-json --verbose`; callers pass
 * everything else (--model, --append-system-prompt, --mcp-config, …).
 */

type OneShotUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type OneShotResult = {
  ok: boolean;
  /** Final assistant text: the result event's `result` string, falling back
   *  to the last streamed assistant text. Empty string on failure. */
  text: string;
  error: string | null;
  status: number | null;
  stderr: string;
  costUsd: number | null;
  usage: OneShotUsage | null;
  model: string | null;
  numTurns: number | null;
  durationMs: number;
};

type StreamFacts = {
  text: string;
  costUsd: number | null;
  usage: OneShotUsage | null;
  model: string | null;
  numTurns: number | null;
};

/** Pure parser over the CLI's NDJSON stdout — unit-testable without spawning. */
export function parseOneShotStream(stdout: string): StreamFacts {
  const facts: StreamFacts = { text: "", costUsd: null, usage: null, model: null, numTurns: null };
  let lastAssistantText = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let evt: {
      type?: string;
      subtype?: string;
      model?: string;
      message?: { model?: string; content?: Array<{ type?: string; text?: string }> };
      result?: unknown;
      total_cost_usd?: number;
      usage?: OneShotUsage;
      num_turns?: number;
    };
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt.type === "system" && typeof evt.model === "string") facts.model = evt.model;
    if (evt.type === "assistant" && evt.message) {
      if (typeof evt.message.model === "string") facts.model = evt.message.model;
      const texts = (evt.message.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      if (texts.length > 0) lastAssistantText = texts.join("\n");
    }
    if (evt.type === "result") {
      if (typeof evt.result === "string" && evt.result.trim()) facts.text = evt.result;
      if (typeof evt.total_cost_usd === "number") facts.costUsd = evt.total_cost_usd;
      if (evt.usage && typeof evt.usage === "object") facts.usage = evt.usage;
      if (typeof evt.num_turns === "number") facts.numTurns = evt.num_turns;
    }
  }
  if (!facts.text) facts.text = lastAssistantText;
  return facts;
}

export function runClaudeOneShot(opts: {
  /** CLI args EXCLUDING -p/--output-format/--verbose (the runner owns those). */
  args: string[];
  input: string;
  timeoutMs: number;
  /** Extra env on top of directClaudeEnv(). */
  env?: Record<string, string>;
}): Promise<OneShotResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      "claude",
      ["-p", "--output-format", "stream-json", "--verbose", ...opts.args],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...directClaudeEnv(), ...(opts.env ?? {}) },
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (error: string | null, status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      child.stdout?.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.off("error", onSpawnError);
      child.off("close", onClose);
      const facts = parseOneShotStream(stdout);
      const failed = error !== null || status !== 0 || facts.text.trim().length === 0;
      resolve({
        ok: !failed,
        text: facts.text.trim(),
        error: failed
          ? (error ??
            (status !== 0
              ? `claude exited ${status}: ${stderr.slice(0, 200)}`
              : "claude produced no output"))
          : null,
        status,
        stderr,
        costUsd: facts.costUsd,
        usage: facts.usage,
        model: facts.model,
        numTurns: facts.numTurns,
        durationMs: Date.now() - startedAt,
      });
    };

    const onOut = (c: Buffer) => {
      stdout += c.toString("utf8");
    };
    const onErr = (c: Buffer) => {
      stderr += c.toString("utf8");
    };
    const onSpawnError = (err: Error) => settle(err.message, null);
    const onClose = (code: number | null) => settle(null, code);

    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch (err) {
        log.warn("one-shot", "SIGTERM failed", { err: (err as Error).message });
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill("SIGKILL");
        } catch {}
      }, 2_000).unref?.();
      settle(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`, null);
    }, opts.timeoutMs);

    child.stdout.on("data", onOut);
    child.stderr.on("data", onErr);
    child.on("error", onSpawnError);
    child.on("close", onClose);
    child.stdin.write(opts.input);
    child.stdin.end();
  });
}
