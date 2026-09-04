import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type InlineImage, prepareInlineImages } from "../claude/inline-images.ts";
import { ensureMcpConfig, envelopeNeedsBrowser, toolEnv } from "../claude/mcp-config.ts";
import { personaFingerprint } from "../claude/persona.ts";
import type { RunInput, RunResult, RunUsage } from "../claude/runner.ts";
import { type ModelActivity, activityDetailForTool, textDeltaForBlock } from "../claude/worker.ts";
import type { Config } from "../config/config.ts";
import { deriveGuestLoadout } from "../guests/access.ts";
import { buildRunSystemPrompt } from "../model/context.ts";
import { type ModelEffort, modelProfileForSession } from "../model/profile.ts";
import { orchestratorForSession } from "../orchestrators/registry.ts";
import { classifyError } from "../recovery/classify.ts";
import { hostAccess } from "../security/policy.ts";
import { isTradingSession } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { humanCount, humanMs, log, snippet } from "../util/log.ts";
import { codexMcpConfigArgs, tomlValue } from "./config.ts";
import { codexExecutable } from "./executable.ts";
import { liveContextForThread } from "./rollout.ts";

export { codexExecutable } from "./executable.ts";

type CodexUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
};

export type CodexJsonEvent = {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string } | string;
  usage?: CodexUsage;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    server?: string;
    tool?: string;
    arguments?: unknown;
    query?: string;
    changes?: unknown;
    [key: string]: unknown;
  };
};

/** Parse one Codex JSONL event without letting a malformed line kill a turn. */
export function parseCodexJsonLine(line: string): CodexJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" ? (value as CodexJsonEvent) : null;
  } catch {
    return null;
  }
}

export type CodexExecArgsInput = {
  model: string;
  effort: ModelEffort;
  contextWindowTokens?: number;
  systemPrompt: string;
  mcpConfig: string;
  images?: InlineImage[];
  guest: boolean;
  /** [security].model_host_access = "sandboxed": keep Codex's own sandbox. */
  sandboxed?: boolean;
  resumeSessionId?: string | null;
  ephemeral?: boolean;
  additionalWritableDirs?: string[];
};

/** Build a deterministic, user-config-isolated `codex exec` invocation. */
export function buildCodexExecArgs(input: CodexExecArgsInput): string[] {
  const resume = Boolean(input.resumeSessionId);
  const args = ["exec", ...(resume ? ["resume"] : [])];
  args.push(
    "--json",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
  );
  if (input.ephemeral) args.push("--ephemeral");
  args.push(
    "-m",
    input.model,
    "-c",
    'approval_policy="never"',
    "-c",
    `model_reasoning_effort=${tomlValue(codexEffort(input.effort))}`,
    "-c",
    `developer_instructions=${tomlValue(codexToolIdentifiers(input.systemPrompt))}`,
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.plugins=false",
    "-c",
    "include_apps_instructions=false",
    "-c",
    "include_collaboration_mode_instructions=false",
    "-c",
    "allow_login_shell=false",
  );
  if (input.contextWindowTokens) {
    args.push("-c", `model_context_window=${input.contextWindowTokens}`);
  }

  if (input.guest) {
    // Unlike the legacy read-only sandbox, a named profile can deny broad
    // reads. `:minimal` retains only the runtime files needed to execute
    // commands; the conversation workspace is intentionally absent.
    args.push(
      "-c",
      'default_permissions="edmund_guest"',
      "-c",
      'permissions.edmund_guest.filesystem={":minimal"="read"}',
      "-c",
      "permissions.edmund_guest.network.enabled=false",
    );
  } else if (input.sandboxed) {
    // [security].model_host_access = "sandboxed": the Claude worker loses its
    // shell and filesystem built-ins, and the Codex worker keeps Codex's own
    // sandbox, confined to the session directory. The two CLIs hold the same
    // keys either way, so switching models does not change what the model
    // can reach.
    args.push("--sandbox", "workspace-write");
  } else {
    // The same trust the Claude worker gets from `--permission-mode
    // bypassPermissions`. The first live day ran workspace-write here, which
    // confined every session to its own sandbox directory — mirror pushes,
    // skills, and anything else outside it failed while the identical Claude
    // turn would have succeeded. The two CLIs must hold the same keys, or
    // switching models silently changes what Edmund is able to do.
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  if (!resume) {
    for (const dir of input.additionalWritableDirs ?? []) args.push("--add-dir", dir);
  }
  args.push(...codexMcpConfigArgs(input.mcpConfig));
  for (const image of input.images ?? []) args.push("-i", image.preparedPath);
  if (resume) args.push(input.resumeSessionId!);
  // `-` is important: passing a prompt argument while stdin is piped makes
  // Codex append stdin as a second <stdin> block.
  args.push("-");
  return args;
}

function codexEffort(effort: ModelEffort): Exclude<ModelEffort, "max"> {
  // Codex CLI 0.147 accepts through xhigh in model_reasoning_effort. Preserve
  // the config's quality-first intent on `max` with the closest CLI value.
  return effort === "max" ? "xhigh" : effort;
}

/**
 * Rewrite MCP tool identifiers the way Codex's runtime names them.
 *
 * Codex exposes tools as normalized JavaScript identifiers — a server
 * registered as `edmund-harness` becomes `tools.mcp__edmund_harness__*`. The
 * shared system prompt spells identifiers Claude-style with the hyphen, and
 * on the first live day the model burned five ALL_TOOLS probing calls per
 * thread rediscovering the underscore spelling (rollout 019ff215,
 * 2026-08-11). One rewrite at this funnel covers the harness catalog, the
 * mirror instructions, and any future hyphenated server.
 */
export function codexToolIdentifiers(prompt: string): string {
  return prompt.replace(/mcp__[A-Za-z0-9_-]+__/g, (identifier) => identifier.replace(/-/g, "_"));
}

/** Run one persistent harness turn through `codex exec` / `exec resume`. */
export async function runCodex(
  rawInput: RunInput,
  config: Config,
  store: StateStore,
): Promise<RunResult> {
  let input = rawInput;
  if (!input.guest) {
    const derived = deriveGuestLoadout(input.sessionKey, config);
    if (derived === "blocked") {
      log.info("codex", "guest session blocked — turn refused", { session: input.sessionKey });
      return { ok: false, error: "guest access revoked for this session; turn refused" };
    }
    if (derived) input = { ...input, guest: derived };
  }

  const existing = store.getSession(input.sessionKey);
  const currentFingerprint = personaFingerprint();
  const personaChanged =
    existing?.claudeSessionId != null &&
    existing.systemPromptHash != null &&
    existing.systemPromptHash !== currentFingerprint;
  if (personaChanged) {
    log.info("codex", "persona edit detected → cold-spawn this turn", {
      session: input.sessionKey,
      old_hash: existing.systemPromptHash?.slice(0, 8),
      new_hash: currentFingerprint.slice(0, 8),
    });
    store.setClaudeSessionId(input.sessionKey, null);
  }
  if (existing && existing.systemPromptHash !== currentFingerprint) {
    store.setSystemPromptHash(input.sessionKey, currentFingerprint);
  }
  const fresh = input.freshSession === true || personaChanged;

  const isGuest = input.guest != null;
  const configs = ensureMcpConfig(config);
  const needsBrowser = !isGuest && (input.browserHint ?? envelopeNeedsBrowser(input.envelope));
  const mcpConfig = isTradingSession(input.sessionKey)
    ? configs.trading
    : isGuest
      ? '{"mcpServers":{}}'
      : needsBrowser
        ? configs.withBrowser
        : configs.default;
  const orchestrator = orchestratorForSession(input.sessionKey, config);
  const orchestratorModel =
    orchestrator && !orchestrator.builtin && orchestrator.model ? orchestrator.model : null;
  const profile = modelProfileForSession(input.sessionKey, config, orchestratorModel);
  // Effort is resolved per BACKEND, not per session. modelProfileForSession
  // answers with `[claude] effort`, which is tuned for Opus; a reasoning model
  // spends the same word very differently, and inheriting "medium" quietly
  // ran gpt-5.6-sol well below what it is capable of.
  const effort = config.codex.effort ?? profile.effort;
  const systemPrompt = buildRunSystemPrompt(input, config, orchestrator);

  const imageCache = join(input.sandboxPath, ".inline-images");
  if (input.images?.length) mkdirSync(imageCache, { recursive: true });
  const images = input.images ? prepareInlineImages(input.images, imageCache) : [];
  if (images.length > 0) {
    log.info("codex", "multimodal input", {
      session: input.sessionKey,
      images: images.length,
      sources: images.map((image) => image.sourcePath),
    });
  }

  const env = toolEnv(
    config,
    input.sessionKey,
    input.sandboxPath,
    input.inboundDepth ?? 0,
    input.guest?.tier ?? null,
  );
  if (isGuest) scrubGuestSecrets(env);
  const timeoutMs = config.claude.timeout_seconds * 1000;

  const attempt = (resumeSessionId?: string | null): Promise<RunResult> => {
    let args: string[];
    let executable: string;
    try {
      executable = codexExecutable();
      args = buildCodexExecArgs({
        model: profile.model,
        effort,
        // Deliberately NOT `[claude] context_window_tokens`. That value is the
        // Claude window and reached Codex as `model_context_window`, telling
        // gpt-5.6-sol it had 400k of room against a real 272k. Unset here means
        // "say nothing", and Codex uses its own per-model metadata.
        contextWindowTokens: config.codex.context_window_tokens,
        systemPrompt,
        mcpConfig,
        images,
        guest: isGuest,
        sandboxed: hostAccess(config) === "sandboxed",
        resumeSessionId,
      });
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message });
    }
    return runCodexProcess({
      executable,
      args,
      input: input.envelope,
      env,
      cwd: input.sandboxPath,
      timeoutMs,
      sessionKey: input.sessionKey,
      model: profile.model,
      knownSessionId: resumeSessionId ?? null,
      onTyping: input.onTyping,
      onActivity: input.onActivity,
      onTextDelta: input.onTextDelta,
      onHeartbeat: input.onHeartbeat,
      signal: input.signal,
    });
  };

  const priorId = fresh ? null : (existing?.claudeSessionId ?? null);
  let result = await attempt(priorId);
  if (!result.ok && priorId && !input.signal?.aborted && isMissingCodexSession(result.error)) {
    log.warn("codex", "stored thread missing — cold-spawning", {
      session: input.sessionKey,
      thread_id: priorId,
    });
    store.setClaudeSessionId(input.sessionKey, null);
    result = await attempt(null);
  }

  if (result.ok) store.clearError(input.sessionKey);
  else if (!input.signal?.aborted) {
    store.recordError(input.sessionKey, classifyError(result.error), Date.now());
  }
  return result;
}

function scrubGuestSecrets(env: Record<string, string>): void {
  for (const key of [
    "EDMUND_OPENAI_KEY",
    "EDMUND_GEMINI_KEY",
    "EDMUND_ELEVENLABS_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY",
    "BRAVE_API_KEY",
  ]) {
    delete env[key];
  }
}

function isMissingCodexSession(error: string): boolean {
  return /no rollout found|thread\/resume failed|session .*not found|unknown (?:thread|session)/i.test(
    error,
  );
}

type ProcessInput = {
  executable: string;
  args: string[];
  input: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  sessionKey: string;
  /** Effective model name, for result-line parity with the Claude worker. */
  model: string;
  knownSessionId: string | null;
  onTyping?: (active: boolean) => void;
  onActivity?: (activity: ModelActivity, detail?: string) => void;
  onTextDelta?: (text: string) => void;
  onHeartbeat?: () => void;
  signal?: AbortSignal;
};

function runCodexProcess(input: ProcessInput): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const mode = input.knownSessionId ? "resume" : "cold";
    log.info("codex", "spawn", {
      session: input.sessionKey,
      mode,
      sessionId: input.knownSessionId ?? undefined,
      input_chars: input.input.length,
    });
    const proc = spawn(input.executable, input.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: input.env,
      cwd: input.cwd,
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let sessionId = input.knownSessionId ?? "";
    let lastAssistantText = "";
    let hasAssistantText = false;
    let toolUseCount = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingSuccess: Extract<RunResult, { ok: true }> | null = null;
    /** Last non-terminal `error` event, kept as context for a real failure. */
    let lastStreamNotice = "";

    const safeTyping = (active: boolean) => {
      try {
        input.onTyping?.(active);
      } catch (err) {
        log.warn("codex", "onTyping threw", {
          session: input.sessionKey,
          err: (err as Error).message,
        });
      }
    };
    const safeActivity = (activity: ModelActivity, detail?: string) => {
      try {
        input.onActivity?.(activity, detail);
      } catch (err) {
        log.warn("codex", "onActivity threw", {
          session: input.sessionKey,
          err: (err as Error).message,
        });
      }
    };
    const finish = (result: RunResult) => {
      if (settled || pendingSuccess) return;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      safeTyping(false);
      if (result.ok) {
        // Codex persists the thread's rollout file (what `exec resume` reads)
        // around the same time it emits turn.completed. Killing the process
        // at the event races that write and can strand the thread id we just
        // promised to resume. Do not return the successful result until the
        // process has actually closed: a rapid follow-up may otherwise start
        // `exec resume` while the rollout is still being flushed.
        pendingSuccess = result;
        flushTimer = setTimeout(() => {
          log.warn("codex", "process did not exit after turn.completed — terminating", {
            session: input.sessionKey,
          });
          terminateProcessTree(proc.pid, "SIGTERM");
          settle(result);
        }, 5_000);
        flushTimer.unref?.();
        return;
      }
      terminateProcessTree(proc.pid, "SIGTERM");
      settle(result);
    };
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (flushTimer) clearTimeout(flushTimer);
      input.signal?.removeEventListener("abort", onAbort);
      safeTyping(false);
      resolve(result);
    };
    const onAbort = () => {
      const reason =
        typeof input.signal?.reason === "string" && input.signal.reason.trim()
          ? input.signal.reason.trim().slice(0, 160)
          : "superseded by user";
      finish({
        ok: false,
        error: `turn interrupted: ${reason}`,
        claudeSessionId: sessionId || undefined,
      });
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
      return;
    }

    const armIdleTimer = () => {
      if (settled || pendingSuccess) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () =>
          finish({
            ok: false,
            error: `idle timeout after ${input.timeoutMs}ms (no stream activity)`,
            claudeSessionId: sessionId || undefined,
          }),
        input.timeoutMs,
      );
    };
    armIdleTimer();

    const consume = (line: string) => {
      const event = parseCodexJsonLine(line);
      if (!event) return;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
        safeActivity("thinking");
        return;
      }
      if (event.type === "turn.started") {
        safeActivity("thinking");
        return;
      }
      if (event.type === "item.started" || event.type === "item.completed") {
        const item = event.item;
        if (!item) return;
        if (item.type === "reasoning") {
          safeActivity("thinking");
          return;
        }
        if (item.type === "agent_message" && event.type === "item.completed") {
          const text = typeof item.text === "string" ? item.text : "";
          if (text) {
            safeActivity("responding");
            safeTyping(true);
            try {
              input.onTextDelta?.(textDeltaForBlock(text, hasAssistantText));
            } catch (err) {
              log.warn("codex", "onTextDelta threw", {
                session: input.sessionKey,
                err: (err as Error).message,
              });
            }
            hasAssistantText = true;
            lastAssistantText = text;
            safeTyping(false);
          }
          return;
        }

        const toolName = codexToolName(item);
        if (toolName) {
          safeActivity(
            toolName.endsWith("send_message") ? "responding" : "working",
            activityDetailForTool(toolName),
          );
          if (event.type === "item.started") {
            toolUseCount++;
            log.info("codex", "tool_use", {
              session: input.sessionKey,
              name: toolName,
              id: item.id,
              input_summary: codexItemSummary(item),
            });
          }
          // A failed builtin command is otherwise invisible: MCP tools log
          // their own results daemon-side, but Codex's Bash/Edit run inside
          // the CLI. The first live day's sandbox denials left no trace here,
          // which made "the model can't do things" undiagnosable from the log.
          if (event.type === "item.completed" && commandFailure(item)) {
            log.warn("codex", "tool failed", {
              session: input.sessionKey,
              name: toolName,
              id: item.id,
              exit_code: item.exit_code,
              output: snippet(String(item.aggregated_output ?? ""), 200),
            });
          }
        }
        return;
      }
      if (event.type === "error") {
        // NOT terminal. The CLI emits these for conditions it is already
        // handling — "Reconnecting... 2/5 (stream disconnected …)" while it
        // retries the stream itself. Treating them as fatal killed a
        // 10-minute, 50-tool turn that Codex was seconds from recovering
        // (observed 2026-08-11, five times in one evening). The notice is
        // kept so a turn that then genuinely dies can say what it saw last.
        lastStreamNotice = codexError(event) || "unspecified stream notice";
        log.warn("codex", "stream notice — CLI is handling it", {
          session: input.sessionKey,
          notice: snippet(lastStreamNotice, 200),
        });
        return;
      }
      if (event.type === "turn.failed") {
        const detail =
          codexError(event) || lastStreamNotice || stderr.trim() || "codex returned error";
        log.error("codex", "result error", {
          session: input.sessionKey,
          dur: humanMs(Date.now() - started),
          model: input.model,
          provider: "openai",
          tools: toolUseCount,
          err: snippet(detail, 200),
        });
        finish({ ok: false, error: detail, claudeSessionId: sessionId || undefined });
        return;
      }
      if (event.type === "turn.completed") {
        const usage = normalizeUsage(event.usage);
        // Live context comes from Codex's own rollout file — the stream's
        // usage is cumulative over the thread's life and says nothing about
        // the context a request actually carries. The estimate is only the
        // fallback for a missing/unreadable rollout, and it deliberately
        // errs high: over-anchoring costs a cold start with history,
        // under-anchoring re-creates the unbounded threads of 2026-08-11.
        const context =
          (sessionId ? liveContextForThread(sessionId) : null) ??
          estimateThreadContext(usage, toolUseCount);
        const reply = lastAssistantText.trim();
        log.info("codex", "result ok", {
          session: input.sessionKey,
          dur: humanMs(Date.now() - started),
          model: input.model,
          provider: "openai",
          tools: toolUseCount,
          reply_chars: reply.length,
          in_total: usage.input_tokens ?? 0,
          out: usage.output_tokens ?? 0,
          cache_read: usage.cache_read_input_tokens ?? 0,
          cache_create: usage.cache_creation_input_tokens ?? 0,
          ctx: humanCount(context),
        });
        finish({
          ok: true,
          reply,
          claudeSessionId: sessionId,
          usage,
          contextTokens: context,
        });
      }
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      armIdleTimer();
      try {
        input.onHeartbeat?.();
      } catch {
        // A lock heartbeat must never break stream parsing.
      }
      stdout += chunk.toString("utf8");
      let newline = stdout.indexOf("\n");
      while (newline !== -1) {
        consume(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => finish({ ok: false, error: err.message }));
    proc.on("close", (code) => {
      if (stdout.trim()) consume(stdout);
      if (settled) return;
      if (pendingSuccess) {
        settle(pendingSuccess);
        return;
      }
      const context = lastStreamNotice ? ` (last stream notice: ${lastStreamNotice})` : "";
      finish({
        ok: false,
        error:
          code === 0
            ? `codex exited without turn.completed event${context}`
            : `codex exit ${code}: ${stderr.trim() || lastStreamNotice || "no stderr"}`,
        claudeSessionId: sessionId || undefined,
      });
    });
    proc.stdin.end(input.input);
  });
}

function normalizeUsage(usage: CodexUsage | undefined): RunUsage {
  return {
    input_tokens: usage?.input_tokens,
    cache_read_input_tokens: usage?.cached_input_tokens,
    cache_creation_input_tokens: usage?.cache_write_input_tokens,
    output_tokens: usage?.output_tokens,
  };
}

/**
 * Fallback context estimate for when the rollout cannot be read.
 *
 * Codex's `turn.completed` usage is cumulative over the thread's WHOLE LIFE
 * (verified against rollouts 2026-08-12: a thread reporting `in=9M` had a
 * real live context of 200k). Dividing by this turn's request count still
 * carries every earlier turn's spend in the numerator, so for an old thread
 * this reads far too high — which is the tolerable direction: it re-anchors
 * a thread we can no longer measure rather than letting it grow unbounded.
 * The real reading is `liveContextForThread` (src/codex/rollout.ts).
 */
export function estimateThreadContext(usage: RunUsage, toolUseCount: number): number {
  return Math.round((usage.input_tokens ?? 0) / (toolUseCount + 1));
}

function codexToolName(item: NonNullable<CodexJsonEvent["item"]>): string | null {
  if (item.type === "mcp_tool_call") {
    return [item.server, item.tool].filter((part) => typeof part === "string").join("__") || "mcp";
  }
  if (item.type === "command_execution") return "Bash";
  if (item.type === "file_change") return "Edit";
  if (item.type === "web_search") return "web_search";
  if (item.type === "plan_update") return "plan_update";
  return null;
}

function codexItemSummary(item: NonNullable<CodexJsonEvent["item"]>): string {
  if (typeof item.command === "string") return snippet(item.command, 160);
  if (typeof item.query === "string") return snippet(item.query, 160);
  if (item.arguments !== undefined) return snippet(stringify(item.arguments), 160);
  // file_change items carry their edits in `changes`; without this the log
  // showed `input_summary=""` for every Edit the model made.
  if (item.changes !== undefined) return snippet(stringify(item.changes), 160);
  return "";
}

/** A completed builtin command that reported a non-zero exit. */
function commandFailure(item: NonNullable<CodexJsonEvent["item"]>): boolean {
  return (
    item.type === "command_execution" && typeof item.exit_code === "number" && item.exit_code !== 0
  );
}

function codexError(event: CodexJsonEvent): string {
  if (typeof event.error === "string") return event.error;
  if (event.error && typeof event.error.message === "string") return event.error.message;
  return typeof event.message === "string" ? event.message : "";
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}
