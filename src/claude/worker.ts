import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { DEBUG, humanCost, humanCount, humanMs, log, shortSession, snippet } from "../util/log.ts";
import { type IterationUsage, contextTokens, iterationContextTokens } from "./auto-compact.ts";

/**
 * A resident `claude -p --input-format stream-json --output-format stream-json`
 * subprocess bound to a single session. Lives across many turns; each new
 * turn is a `{type:"user", message:{...}}` JSON event written to stdin and
 * an event stream read off stdout until a `{type:"result"}` event arrives.
 *
 * Why this exists: the per-turn spawn pays ~500-1500 ms of Node startup +
 * CLI bootstrap + MCP subprocess cold start + Anthropic API connection
 * setup. A resident worker amortizes all of that over the conversation, and
 * Anthropic prompt caching kicks in: the second turn in the same process
 * reads tens of thousands of tokens from cache instead of re-tokenizing.
 *
 * Worker is bound to one (sessionKey, sandboxPath, sender identity,
 * inboundDepth) tuple. If any of those change, the WorkerPool recycles it.
 * Note that `senderLabel`/`senderHandle` are NOT really per-turn — for DM
 * sessions they're constant; for group sessions they're whoever sent the
 * triggering message in this batch. We handle that by passing the sender
 * info as part of the event envelope text, not the system prompt — so the
 * system prompt stays stable for the whole worker lifetime.
 *
 * One subtle CLI behavior verified by spike (see docs/design/resident-agent-plan.md):
 * `claude -p --input-format stream-json` accepts multiple `{type:"user"}`
 * events on the same stdin without exiting after the first result, and
 * Anthropic prompt caching IS reused across those events. Each event still
 * emits its own `{type:"system",subtype:"init"}` (the CLI re-attaches to
 * the same session id per event) but the conversation state is preserved.
 *
 * Idle timeout semantics: the per-turn idle timer is armed when we send a
 * user event and cleared when we receive its result. Between turns the
 * worker can sit idle indefinitely — the WorkerPool's separate idle-evict
 * sweep handles long-quiet sessions.
 */

export type WorkerSpawnArgs = {
  /** Full argv passed to `claude` — built by the caller (model, effort,
   *  system prompt, mcp config, resume/session-id, etc.). The worker is
   *  agnostic to which flags are set. */
  argv: string[];
  /** Env vars for the subprocess (and for its MCP child via inheritance). */
  env: Record<string, string>;
  /** cwd — the per-session sandbox path. Mirrors the existing runner. */
  cwd: string;
  /** Per-turn idle timeout in ms. Resets on every stdout event. */
  perTurnIdleMs: number;
  /** Logical session key for log lines / pool indexing. */
  sessionKey: string;
};

export type ModelActivity = "thinking" | "working" | "responding";

export function modelActivityForBlock(type: string, toolName?: string): ModelActivity {
  if (type === "text" || (type === "tool_use" && toolName === "send_message")) {
    return "responding";
  }
  if (type === "tool_use") return "working";
  return "thinking";
}

/**
 * Plain-language description of what a tool call is doing, for the mirror's
 * status line. A long turn otherwise shows an unchanging "Working" for a
 * minute or more, which is indistinguishable from being stuck.
 *
 * Deliberately vague-but-honest: the point is reassurance that something is
 * happening, not an audit trail. Matched loosely because tools arrive
 * MCP-prefixed (`mcp__edmund-harness__web_search`).
 */
export function activityDetailForTool(toolName?: string): string | undefined {
  if (!toolName) return undefined;
  const name = toolName.replace(/^mcp__[^_]*(?:__)?/, "").toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/web_search|websearch|brave|search/, "searching the web"],
    [/web_fetch|webfetch|fetch|curl/, "reading a page"],
    [/mirror_content|render_mirror|update_mirror|push_mirror|asset/, "updating the screen"],
    [/generate_image|image/, "making an image"],
    [/generate_video|video/, "making a video"],
    [/speak_on_mirror|speak/, "talking"],
    [/^(bash|shell)$/, "running a command"],
    [/^(read|glob|grep|find)$/, "reading files"],
    [/^(write|edit|notebookedit)$/, "editing files"],
    [/agent|task/, "running a sub-task"],
    [/weather|radar|warning/, "checking the weather"],
    [/calendar|event/, "checking the calendar"],
    [/memory|recall/, "checking what it remembers"],
  ];
  for (const [pattern, label] of rules) if (pattern.test(name)) return label;
  return "working on it";
}

export type WorkerTurn = {
  /** The serialized stream-json input event(s). Caller is responsible for
   *  framing — for text-only that's one user event; for multimodal it's
   *  whatever `buildStreamJsonInput` produces. */
  stdinPayload: string;
  /**
   * Fine-grained typing signal driven by the partial-message stream:
   *  - true: the model has STARTED a user-facing text block (either a
   *    direct text content block, or a `tool_use` block whose tool is
   *    `send_message` — i.e., it's about to deliver text mid-turn).
   *  - false: the block ended, OR the model is currently in a non-text
   *    phase (thinking, tool_use other than send_message, tool_result).
   *
   * Fired potentially many times per turn — every block start/stop. The
   * caller (TypingSession) is idempotent, so repeated `true`s are fine.
   */
  onTyping?: (active: boolean) => void;
  /** Structural model phase, emitted from content-block/tool events. */
  onActivity?: (activity: ModelActivity, detail?: string) => void;
  /** Text deltas from the active assistant content block. */
  onTextDelta?: (text: string) => void;
  /**
   * Liveness heartbeat — fired on EVERY stdout chunk from the subprocess,
   * i.e. exactly when the per-turn idle timer re-arms. The session-lock
   * lease rides this signal (SessionLocks.touch): as long as the turn is
   * demonstrably streaming, the lock stays held; the callee throttles, so
   * per-chunk frequency is fine.
   */
  onHeartbeat?: () => void;
  /** Cancels this turn and retires the worker so no stale events can leak. */
  signal?: AbortSignal;
};

export type WorkerResult =
  | {
      ok: true;
      reply: string;
      claudeSessionId: string;
      toolUses: number;
      durationMs: number;
      usage?: UsageStats;
      /** Real context size of the turn — the largest single API call,
       *  measured from streamed assistant-event usage (fallback:
       *  contextTokens(usage)). Feed THIS to shouldCompact. */
      contextTokens?: number;
      totalCostUsd?: number;
    }
  | { ok: false; error: string; claudeSessionId: string | undefined; durationMs: number };

type ContentBlock =
  | { type: "text"; text?: string }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

type ClaudeEvent =
  | { type: "system"; subtype: "init"; session_id: string; model?: string }
  | {
      type: "assistant";
      message: { content: Array<ContentBlock>; model?: string; usage?: UsageStats };
      session_id?: string;
      /** Set when the event belongs to an in-process subagent's stream —
       *  its usage describes the SUBAGENT's context, not this session's. */
      parent_tool_use_id?: string | null;
    }
  | { type: "user"; message: { content: Array<ContentBlock> } }
  | {
      type: "result";
      subtype: "success" | "error";
      result?: string;
      is_error?: boolean;
      session_id?: string;
      usage?: UsageStats;
      total_cost_usd?: number;
    }
  | { type: "stream_event"; event: StreamEvent; session_id?: string };

type UsageStats = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  /** Per-API-call usage — one entry per model round-trip in the turn's
   *  tool loop. The top-level fields above SUM these entries. */
  iterations?: IterationUsage[];
};

/** Anthropic API stream event subtypes Claude Code surfaces when
 *  `--include-partial-messages` is on. We only care about the lifecycle
 *  events that delimit content blocks; deltas are ignored. */
type StreamEvent =
  | { type: "message_start" }
  | { type: "message_delta" }
  | { type: "message_stop" }
  | {
      type: "content_block_start";
      index?: number;
      content_block: { type: "text" | "thinking" | "tool_use"; name?: string };
    }
  | {
      type: "content_block_delta";
      index?: number;
      delta: { type: string; text?: string };
    }
  | { type: "content_block_stop"; index?: number };

export class Worker {
  private proc: ChildProcessWithoutNullStreams;
  private stdoutBuf = "";
  /** Rolling tail of stderr (last ~2 KB). Appended to death errors so the
   *  caller can see *why* the worker died — without this, the pool's
   *  collision-fallback regex (looks for "already in use") misses every
   *  time and stuck sessions never recover. */
  private stderrTail = "";
  private static readonly STDERR_TAIL_MAX = 2048;
  /** Resolves the current turn when its `result` event arrives. */
  private pending: {
    resolve: (r: WorkerResult) => void;
    sessionId: string | undefined;
    lastAssistantText: string;
    /** Model id from the LAST assistant event — the model Claude Code
     *  reports for the turn. Empty until the first assistant event. */
    model: string;
    toolUses: number;
    /** Largest single API call seen this turn (read+create+input from
     *  streamed assistant-event usage) — the turn's real context size.
     *  Preferred over the result event's usage, whose totals sum every
     *  round-trip and whose `iterations` shape is undocumented. */
    maxCallContextTokens: number;
    startedAt: number;
    idleTimer: ReturnType<typeof setTimeout>;
    armIdle: () => void;
    onTyping?: (active: boolean) => void;
    typingActive: boolean;
    onActivity?: (activity: ModelActivity, detail?: string) => void;
    activity: ModelActivity | null;
    /** Last detail reported, so an unchanged one doesn't re-fire. */
    activityDetail?: string;
    onTextDelta?: (text: string) => void;
    onHeartbeat?: () => void;
    hasStreamedText: boolean;
    textBlockNeedsSeparator: boolean;
    removeAbort?: () => void;
  } | null = null;
  /** The session id observed on the FIRST init event. Subsequent events
   *  must match it; if they don't, the worker is poisoned and must be
   *  shut down. (Defensive — the CLI should keep it stable.) */
  private boundSessionId: string | null = null;
  private deadReason: string | null = null;
  private deathHandlers: Array<(reason: string) => void> = [];
  private idleMs: number;
  private sessionKey: string;

  constructor(args: WorkerSpawnArgs) {
    this.idleMs = args.perTurnIdleMs;
    this.sessionKey = args.sessionKey;

    // Spawn-line moved to DEBUG: the pool emits MISS (cold spawn) for the
    // same event immediately after, carrying mode/model. Two info lines per
    // spawn was redundant and accounted for ~1300 lines in the daemon log.
    log.debug("claude-worker", "spawn", describeSpawn(args));
    log.debug("claude-worker", "spawn argv-full", {
      session: args.sessionKey,
      argv: args.argv,
    });
    this.proc = spawn("claude", args.argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: args.env,
      cwd: args.cwd,
      detached: true,
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.pending?.armIdle();
      try {
        this.pending?.onHeartbeat?.();
      } catch (err) {
        log.warn("claude-worker", "onHeartbeat threw", {
          err: (err as Error).message,
          session: args.sessionKey,
        });
      }
      this.stdoutBuf += chunk.toString("utf8");
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line splitter
      while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
        const line = this.stdoutBuf.slice(0, nl).trim();
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let evt: ClaudeEvent;
        try {
          evt = JSON.parse(line) as ClaudeEvent;
        } catch {
          continue;
        }
        this.handleEvent(evt);
      }
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const raw = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + raw).slice(-Worker.STDERR_TAIL_MAX);
      const s = raw.trim();
      if (s) log.warn("claude-worker", `stderr: ${s.slice(0, 200)}`, { session: args.sessionKey });
    });

    this.proc.on("error", (err) => {
      this.die(`spawn error: ${err.message}`);
    });
    this.proc.on("exit", (code, signal) => {
      this.die(`exited code=${code} signal=${signal}`);
    });
  }

  /** Has the underlying process died? */
  get isDead(): boolean {
    return this.deadReason !== null;
  }

  /** Reason the worker died — null while alive. Used by the pool to surface
   *  why warm workers keep getting discarded (key signal for cold-spawn
   *  latency). */
  get deathReason(): string | null {
    return this.deadReason;
  }

  /** The claude session id this worker is bound to (known after first turn). */
  get sessionId(): string | null {
    return this.boundSessionId;
  }

  /** Subscribe to death events (used by the pool to purge dead workers). */
  onDeath(handler: (reason: string) => void): void {
    if (this.deadReason !== null) handler(this.deadReason);
    else this.deathHandlers.push(handler);
  }

  /** Run one turn. Caller must serialize calls — a worker handles at most
   *  one turn at a time. The pool enforces this via its `busy` flag. */
  turn(payload: WorkerTurn): Promise<WorkerResult> {
    if (payload.signal?.aborted) {
      return Promise.resolve({
        ok: false,
        error: `turn interrupted: ${abortReason(payload.signal)}`,
        claudeSessionId: this.boundSessionId ?? undefined,
        durationMs: 0,
      });
    }
    if (this.deadReason !== null) {
      return Promise.resolve({
        ok: false,
        error: `worker dead: ${this.deadReason}`,
        claudeSessionId: this.boundSessionId ?? undefined,
        durationMs: 0,
      });
    }
    if (this.pending) {
      // Caller bug: trying to start a turn while another is in flight.
      return Promise.resolve({
        ok: false,
        error: "worker busy with a prior turn",
        claudeSessionId: this.boundSessionId ?? undefined,
        durationMs: 0,
      });
    }
    return new Promise<WorkerResult>((resolve) => {
      const startedAt = Date.now();
      const finish = (r: WorkerResult) => {
        if (!this.pending) return;
        clearTimeout(this.pending.idleTimer);
        this.pending.removeAbort?.();
        this.pending = null;
        resolve(r);
      };
      const armIdle = () => {
        if (!this.pending) return;
        clearTimeout(this.pending.idleTimer);
        this.pending.idleTimer = setTimeout(() => {
          log.warn("claude-worker", "per-turn idle timeout", {
            session: this.sessionKey,
            idleMs: this.idleMs,
          });
          finish({
            ok: false,
            error: `idle timeout after ${this.idleMs}ms (no stream activity)`,
            claudeSessionId: this.boundSessionId ?? undefined,
            durationMs: Date.now() - startedAt,
          });
          // The worker may still be working — tear it down so the pool
          // doesn't reuse a process that's about to emit a stale result.
          this.die("turn idle timeout");
        }, this.idleMs);
      };

      this.pending = {
        resolve: (r) => finish(r),
        sessionId: this.boundSessionId ?? undefined,
        lastAssistantText: "",
        model: "",
        toolUses: 0,
        maxCallContextTokens: 0,
        startedAt,
        idleTimer: setTimeout(() => {}, 0),
        armIdle,
        onTyping: payload.onTyping,
        typingActive: false,
        onActivity: payload.onActivity,
        activity: null,
        onTextDelta: payload.onTextDelta,
        onHeartbeat: payload.onHeartbeat,
        hasStreamedText: false,
        textBlockNeedsSeparator: false,
      };
      if (payload.signal) {
        const onAbort = () => this.die(`turn interrupted: ${abortReason(payload.signal!)}`);
        payload.signal.addEventListener("abort", onAbort, { once: true });
        this.pending.removeAbort = () => payload.signal?.removeEventListener("abort", onAbort);
      }
      armIdle();

      this.proc.stdin.write(
        payload.stdinPayload.endsWith("\n") ? payload.stdinPayload : `${payload.stdinPayload}\n`,
        (err) => {
          if (err)
            finish({
              ok: false,
              error: `stdin write failed: ${err.message}`,
              claudeSessionId: this.boundSessionId ?? undefined,
              durationMs: Date.now() - startedAt,
            });
        },
      );
    });
  }

  /**
   * Inject Claude Code's built-in `/compact` slash command via stdin.
   *
   * Replaces our homemade summarizer-subprocess. Claude Code compacts
   * the persistent session JSONL in place: the model sees its prior
   * conversation as a single condensed system message and continues
   * with the same session id, same warm worker, no cold-spawn, no
   * external summarization, no amnesia for in-flight work.
   *
   * Reuses `turn()` because `/compact` is delivered as a normal user
   * stream-json event; Claude Code recognizes the slash prefix and
   * intercepts. The result event closes the call exactly like a normal
   * turn so the existing finish/idle/death plumbing works unchanged.
   *
   * Caller is responsible for ensuring no in-flight `turn()` (busy
   * collision returns the standard "worker busy" error).
   *
   * `signal` aborts the compact mid-flight (the deferred-compact path
   * aborts when a user message arrives). Abort takes the normal
   * turn-interrupt path: the worker dies and is respawned cold on the
   * next turn — the same teardown user-driven turn interrupts already
   * exercise, so no new failure mode.
   */
  compact(signal?: AbortSignal): Promise<WorkerResult> {
    const stdinPayload = `${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "/compact" }],
      },
    })}\n`;
    return this.turn({ stdinPayload, signal });
  }

  /** Gracefully end the worker. End stdin first so the CLI sees EOF and
   *  shuts down cleanly; SIGTERM as a backup. */
  async shutdown(reason: string): Promise<void> {
    if (this.deadReason !== null) return;
    log.info("claude-worker", "shutting down", { session: this.sessionKey, reason });
    try {
      this.proc.stdin.end();
    } catch {}
    // Brief grace period for clean exit; then SIGTERM.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        terminateProcessTree(this.proc.pid, "SIGTERM");
        resolve();
      }, 2000);
      this.proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private die(reason: string): void {
    if (this.deadReason !== null) return;
    // Surface stderr tail so the caller's classifier can see the real cause
    // (e.g. "Session ID … is already in use"). Without this, every cold-spawn
    // collision returns the same opaque "exited code=1 signal=null" and the
    // pool's collision-fallback never fires.
    const stderr = this.stderrTail.trim();
    const fullReason = stderr ? `${reason} | stderr: ${stderr.slice(-400)}` : reason;
    this.deadReason = fullReason;
    // Ensure the subprocess is actually gone. Previously die() just flipped
    // a flag — the underlying claude process kept running, holding open the
    // session JSONL and (post idle-timeout) emitting late events into a
    // dangling buffer.
    if (this.proc.exitCode === null && !this.proc.killed) {
      try {
        terminateProcessTree(this.proc.pid, "SIGTERM");
      } catch (err) {
        log.warn("claude-worker", "SIGTERM failed", {
          session: this.sessionKey,
          err: (err as Error).message,
        });
      }
      const proc = this.proc;
      setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          try {
            terminateProcessTree(proc.pid, "SIGKILL");
          } catch (err) {
            log.warn("claude-worker", "SIGKILL failed; subprocess may linger", {
              session: this.sessionKey,
              err: (err as Error).message,
            });
          }
        }
      }, 2000).unref?.();
    }
    // Fail an in-flight turn so the caller doesn't wait forever.
    // CRITICAL: `p.resolve` here is the `finish` wrapper (see turn()) which
    // bails when `this.pending` is null. So we must NOT pre-null it — let
    // finish do the null + clearTimeout + raw resolve atomically. The
    // previous code nulled pending first, which made finish bail without
    // resolving the outer Promise, causing pool.run() to hang forever and
    // breaking the cold-start collision fallback (and any other die() path).
    if (this.pending) {
      this.pending.resolve({
        ok: false,
        error: `worker died: ${fullReason}`,
        claudeSessionId: this.boundSessionId ?? undefined,
        durationMs: Date.now() - this.pending.startedAt,
      });
    }
    for (const h of this.deathHandlers.splice(0)) {
      try {
        h(fullReason);
      } catch (err) {
        log.warn("claude-worker", "death handler threw", {
          err: (err as Error).message,
          session: this.sessionKey,
        });
      }
    }
  }

  /** Push the typing signal to the caller if it changed. Idempotent on
   *  same-state calls so we can be liberal about emitting. */
  private setTyping(active: boolean): void {
    if (!this.pending) return;
    if (this.pending.typingActive === active) return;
    this.pending.typingActive = active;
    try {
      this.pending.onTyping?.(active);
    } catch (err) {
      log.warn("claude-worker", "onTyping threw", {
        err: (err as Error).message,
        session: this.sessionKey,
      });
    }
  }

  private setActivity(activity: ModelActivity, detail?: string): void {
    if (!this.pending) return;
    // Re-fire on a changed DETAIL even when the coarse activity is unchanged:
    // a long turn stays "working" across many tools, and the detail is the
    // only thing that tells the user it is still moving.
    if (this.pending.activity === activity && this.pending.activityDetail === detail) return;
    this.pending.activity = activity;
    this.pending.activityDetail = detail;
    try {
      this.pending.onActivity?.(activity, detail);
    } catch (err) {
      log.warn("claude-worker", "onActivity threw", {
        err: (err as Error).message,
        session: this.sessionKey,
      });
    }
  }

  private handleEvent(evt: ClaudeEvent): void {
    if (evt.type === "stream_event") {
      this.handleStreamEvent(evt.event);
      return;
    }
    if (evt.type === "system" && evt.subtype === "init") {
      if (this.boundSessionId === null) {
        this.boundSessionId = evt.session_id;
        log.debug("claude-worker", "session bound", {
          session: this.sessionKey,
          claudeSessionId: evt.session_id,
        });
      } else if (this.boundSessionId !== evt.session_id) {
        // CLI changed the session id mid-stream. Shouldn't happen with our
        // current flags, but if it does, the worker is no longer bound to
        // the conversation we asked for — kill it.
        log.error("claude-worker", "session id changed mid-stream", {
          session: this.sessionKey,
          old: this.boundSessionId,
          new: evt.session_id,
        });
        this.die(`session id changed: ${this.boundSessionId} → ${evt.session_id}`);
      }
      return;
    }
    if (evt.type === "assistant") {
      if (!this.pending) return;
      // Record the model Claude Code reports for this assistant event.
      if (evt.message.model) this.pending.model = evt.message.model;
      // Per-call context tracking: each assistant event carries its API
      // call's own usage (repeated across the call's content blocks —
      // max() makes the repeats harmless). Skip subagent streams.
      if (!evt.parent_tool_use_id && evt.message.usage) {
        this.pending.maxCallContextTokens = Math.max(
          this.pending.maxCallContextTokens,
          iterationContextTokens(evt.message.usage),
        );
      }
      const blocks = evt.message.content;
      for (const block of blocks) {
        const toolName =
          block.type === "tool_use" && typeof block.name === "string" ? block.name : undefined;
        this.setActivity(
          modelActivityForBlock(block.type, toolName),
          block.type === "tool_use" ? activityDetailForTool(toolName) : undefined,
        );
      }
      const text = blocks
        .filter((b): b is { type: "text"; text?: string } => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();
      if (text) this.pending.lastAssistantText = text;
      for (const b of blocks) {
        if (b.type === "tool_use") {
          this.pending.toolUses++;
          const tu = b as { name?: string; id?: string; input?: unknown };
          // Tool name in the message text (not a field) so the log viewer's
          // event column reads "tool_use Bash" instead of a bare "tool_use"
          // with the name buried in the field tail.
          log.info("claude-worker", `tool_use ${shortToolName(tu.name)}`, {
            session: this.sessionKey,
            id: tu.id,
            input_summary: summarizeToolInput(tu.input),
          });
          log.debug("claude-worker", "tool_use input-full", {
            session: this.sessionKey,
            name: tu.name,
            input: tu.input,
          });
        }
      }
      return;
    }
    if (evt.type === "user") {
      if (!this.pending) return;
      for (const b of evt.message.content) {
        if (b.type === "tool_result") {
          this.setActivity("thinking");
          if (!DEBUG) continue;
          const tr = b as { tool_use_id?: string; is_error?: boolean; content?: unknown };
          log.debug("claude-worker", "tool_result", {
            session: this.sessionKey,
            tool_use_id: tr.tool_use_id,
            is_error: tr.is_error,
            preview: snippet(summarizeToolResult(tr.content), 160),
          });
        }
      }
      return;
    }
    if (evt.type === "result") {
      if (!this.pending) return;
      // Turn done — typing must be off regardless of whether content_block_stop
      // already fired (defensive against malformed/missing partial events).
      this.setTyping(false);
      const p = this.pending;
      const dur = Date.now() - p.startedAt;
      if (evt.is_error) {
        const detail = evt.result?.trim() || "claude returned error";
        log.error("claude-worker", "result error", {
          session: this.sessionKey,
          dur: humanMs(dur),
          ...formatModel(p.model),
          tools: p.toolUses,
          err: snippet(detail, 200),
        });
        p.resolve({
          ok: false,
          error: detail,
          claudeSessionId: this.boundSessionId ?? undefined,
          durationMs: dur,
        });
        return;
      }
      const reply = (evt.result ?? p.lastAssistantText).trim();
      const ctxTokens =
        p.maxCallContextTokens > 0 ? p.maxCallContextTokens : contextTokens(evt.usage);
      log.info("claude-worker", "result ok", {
        session: this.sessionKey,
        dur: humanMs(dur),
        ...formatModel(p.model),
        tools: p.toolUses,
        reply_chars: reply.length,
        ...formatUsage(evt.usage, evt.total_cost_usd, ctxTokens),
      });
      p.resolve({
        ok: true,
        reply,
        claudeSessionId: this.boundSessionId ?? evt.session_id ?? "",
        toolUses: p.toolUses,
        durationMs: dur,
        usage: evt.usage,
        contextTokens: ctxTokens,
        totalCostUsd: evt.total_cost_usd,
      });
    }
  }

  /**
   * Stream-event handler — drives the typing signal off the model's actual
   * content-generation lifecycle. Universal rule:
   *
   *   typing ON  iff the model is currently producing user-facing text.
   *   typing OFF for thinking, tool calls (other than send_message),
   *              tool results, and gaps between blocks.
   *
   * That means the bubble appears the instant the model starts generating
   * a text reply (or starts streaming the `text` input of a send_message
   * mid-turn tool call), and disappears the instant that block ends — so
   * for any tool work the model does in between, the bubble is dark.
   */
  private handleStreamEvent(evt: StreamEvent): void {
    if (!this.pending) return;
    switch (evt.type) {
      case "content_block_start": {
        const cb = evt.content_block;
        const kind = cb.type;
        // User-facing text: a direct text block, OR a `send_message` tool
        // call whose `text` input is about to stream in. Anything else
        // (thinking, other tool calls) → typing off.
        const isUserText = kind === "text" || (kind === "tool_use" && cb.name === "send_message");
        if (kind === "text") {
          this.pending.textBlockNeedsSeparator = this.pending.hasStreamedText;
        }
        this.setActivity(modelActivityForBlock(kind, cb.name));
        this.setTyping(isUserText);
        return;
      }
      case "content_block_stop": {
        // Block ended. If it was a text block, the reply is fully composed
        // and about to be emitted as an assistant event → about to land
        // in the caller's hands → typing off. The caller's sendDeliver
        // step (or the result event below) is the real "message lands"
        // signal; here we just stop pulsing typing.
        this.setTyping(false);
        return;
      }
      case "content_block_delta": {
        if (evt.delta.type !== "text_delta" || typeof evt.delta.text !== "string") return;
        try {
          this.pending.onTextDelta?.(
            textDeltaForBlock(evt.delta.text, this.pending.textBlockNeedsSeparator),
          );
          this.pending.textBlockNeedsSeparator = false;
          this.pending.hasStreamedText = true;
        } catch (err) {
          log.warn("claude-worker", "onTextDelta threw", {
            err: (err as Error).message,
            session: this.sessionKey,
          });
        }
        return;
      }
      case "message_stop":
        // Whole assistant message done. Defensive: typing off in case
        // we missed a content_block_stop.
        this.setTyping(false);
        return;
      default:
        return;
    }
  }
}

/**
 * Claude may emit a reply as multiple text content blocks. Each block's first
 * text delta does not carry the paragraph boundary, so joining raw deltas
 * directly produces "...sentence.Next...". Preserve an existing leading
 * newline/space when the provider supplies one; otherwise add the boundary.
 */
export function textDeltaForBlock(delta: string, needsSeparator: boolean): string {
  if (!needsSeparator || /^\s/.test(delta)) return delta;
  return `\n\n${delta}`;
}

/** Pull the actually-informative fields out of the raw argv so the spawn log
 *  reads like a status line ("resuming d429df9b, opus medium") instead of
 *  a 400-char JSON dump. Constants that never vary turn-to-turn
 *  (input_fmt, output_fmt, perm, sys_prompt_chars, cwd, idle_timeout_ms)
 *  are kept behind DEBUG — they're noise in normal flow and were
 *  responsible for the longest log lines in the daemon log.
 *  The full argv still lands at DEBUG via the separate "spawn argv-full"
 *  line.  */
function describeSpawn(args: WorkerSpawnArgs): Record<string, unknown> {
  const argv = args.argv;
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const resumeId = get("--resume");
  const cohortId = get("--session-id");
  const model = get("--model") ?? "?";
  const effort = get("--effort") ?? "?";
  const mcpConfig = get("--mcp-config");

  let mode: string;
  if (resumeId) mode = `resume ${resumeId.slice(0, 8)}…`;
  else if (cohortId) mode = `cold (session-id ${cohortId.slice(0, 8)}…)`;
  else mode = "cold (fresh)";

  const base: Record<string, unknown> = {
    session: args.sessionKey,
    mode,
    model,
    effort,
    mcp: mcpConfig ? mcpConfigName(mcpConfig) : "none",
  };
  if (DEBUG) {
    const inputFmt = get("--input-format") ?? "text";
    const outputFmt = get("--output-format") ?? "text";
    const sysPrompt = get("--append-system-prompt");
    const permMode = get("--permission-mode") ?? "default";
    base.input_fmt = inputFmt;
    base.output_fmt = outputFmt;
    base.perm = permMode;
    base.sys_prompt_chars = sysPrompt?.length ?? 0;
    base.cwd = args.cwd;
    base.idle_timeout_ms = args.perTurnIdleMs;
  }
  return base;
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" && signal.reason.trim()
    ? signal.reason.trim().slice(0, 160)
    : "superseded by user";
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The worker already exited.
    }
  }
}

function mcpConfigName(path: string): string {
  // ../data/mcp.json → mcp.json
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** MCP prefixes triple line length for no reader value —
 *  `mcp__edmund-harness__send_message` → `send_message`. */
function shortToolName(name: string | undefined): string {
  if (!name) return "?";
  return name.replace(/^mcp__.+?__/, "");
}

function summarizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string") {
      out[k] = v.length > 120 ? `${v.slice(0, 120)}…(len=${v.length})` : v;
    } else if (Array.isArray(v)) {
      out[k] = `[${v.length} items]`;
    } else if (v && typeof v === "object") {
      out[k] = "{obj}";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Format usage stats for the `result ok` log line. Surfaces cache hit
 * rate so we can confirm Anthropic's prompt cache is doing its job
 * across turns of the same session. `hit%` = cache_read / (cache_read
 * + cache_creation + uncached_input). Token counts go through
 * humanCount so the log line stays scannable ("577k" beats "576704").
 */
/**
 * Which model Claude Code reported for the `result` log line. Empty model
 * means the turn errored before any assistant event.
 */
function formatModel(model: string): Record<string, unknown> {
  if (!model) return {};
  return { model, provider: "anthropic" };
}

function formatUsage(
  usage: UsageStats | undefined,
  costUsd: number | undefined,
  ctxTokens: number,
): Record<string, unknown> {
  if (!usage) return {};
  const inp = usage.input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const create = usage.cache_creation_input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const cacheable = read + create + inp;
  const hitPct = cacheable > 0 ? Math.round((read / cacheable) * 100) : 0;
  const result: Record<string, unknown> = {
    // `tokens` sums every API call in the turn's tool loop; `ctx` is the
    // largest single call — the number the auto-compact threshold is
    // judged against. On a 10-tool turn these differ by ~10×.
    tokens: `${humanCount(inp)}in + ${humanCount(read)}cache-read + ${humanCount(create)}cache-write → ${humanCount(out)}out`,
    ctx: humanCount(ctxTokens),
    cache: `${hitPct}%`,
  };
  if (typeof costUsd === "number") result.cost = humanCost(costUsd);
  return result;
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) => c.text ?? `[${c.type ?? "?"}]`)
      .join(" ");
  }
  return JSON.stringify(content ?? "").slice(0, 300);
}
