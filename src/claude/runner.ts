import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/config.ts";
import { deriveGuestLoadout } from "../guests/access.ts";
import { buildRunSystemPrompt } from "../model/context.ts";
import { modelProfileForSession } from "../model/profile.ts";
import { orchestratorForSession } from "../orchestrators/registry.ts";
import { classifyError } from "../recovery/classify.ts";
import { HEALERS } from "../recovery/healers.ts";
import { disallowedBuiltinTools, hostAccess } from "../security/policy.ts";
import type { SessionKey } from "../sessions/key.ts";
import { isTradingSession } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { DEBUG, humanCount, humanMs, log, snippet } from "../util/log.ts";
import { type IterationUsage, contextTokens, iterationContextTokens } from "./auto-compact.ts";
import { type InlineImage, prepareInlineImages } from "./inline-images.ts";
import { ensureMcpConfig, envelopeNeedsBrowser, toolEnv } from "./mcp-config.ts";
import { personaFingerprint } from "./persona.ts";
import { WorkerPool } from "./pool.ts";
import {
  SESSION_SIZE_SOFT_LIMIT,
  TARGET_AFTER_COMPACT,
  compactSession,
  sessionFilePath,
} from "./session-compact.ts";
import { ensureSessionLink } from "./session-store.ts";
import {
  type ModelActivity,
  type WorkerResult,
  type WorkerSpawnArgs,
  type WorkerTurn,
  modelActivityForBlock,
  textDeltaForBlock,
} from "./worker.ts";

/**
 * Process-wide WorkerPool singleton. Constructed once on first use when
 * `config.claude.pool.enabled` is true; null otherwise. `getPool` is the
 * gateway — if it returns null, the runner falls back to spawn-per-turn.
 */
let workerPool: WorkerPool | null = null;
function getPool(config: Config): WorkerPool | null {
  if (!config.claude.pool.enabled) return null;
  if (!workerPool) {
    workerPool = new WorkerPool({
      maxWorkers: config.claude.pool.max_workers,
      idleEvictMs: config.claude.pool.idle_evict_ms,
      perTurnIdleMs: config.claude.timeout_seconds * 1000,
    });
    log.info("claude", "worker pool initialized", {
      max: config.claude.pool.max_workers,
      idleEvictMs: config.claude.pool.idle_evict_ms,
    });
  }
  return workerPool;
}

/** Test/shutdown helper: drain the pool and clear the singleton. */
export async function shutdownWorkerPool(): Promise<void> {
  if (!workerPool) return;
  await workerPool.stop();
  workerPool = null;
}

/** Probe: is a worker currently bound to this session? Used by compaction
 *  to defer JSONL rewrites while a live worker has the file open. */
function hasResidentWorker(sessionKey: SessionKey): boolean {
  return workerPool?.hasWorker(sessionKey) ?? false;
}

/** Evict this session's warm worker (if any). Used by healers that
 *  rewrite the persisted session JSONL — the resident process holds the
 *  broken transcript in memory, so without an eviction the repair never
 *  takes effect for exactly the session that errored. */
export async function evictWarmWorker(sessionKey: SessionKey, reason: string): Promise<boolean> {
  if (!workerPool?.hasWorker(sessionKey)) return false;
  await workerPool.evict(sessionKey, reason);
  return true;
}

/** Read-only snapshot of pool internals. null if the pool has never been
 *  initialized (pool disabled or no turns yet). */
export function getWorkerPoolStats() {
  return workerPool?.getStats() ?? null;
}

/** True while any pooled worker is mid-turn. Background maintenance (e.g.
 *  the RadarOmega freshness restart) uses this to defer until quiet. */
export function isWorkerPoolBusy(): boolean {
  return workerPool?.anyBusy() ?? false;
}

/** Force-evict every resident worker. Returns count evicted. */
export async function flushWorkerPool(): Promise<number> {
  if (!workerPool) return 0;
  return workerPool.flushAll("dashboard flush");
}

/** Inject Claude Code's `/compact` slash command into this session's warm
 *  worker, compacting the persistent JSONL in place. Returns null when there's
 *  no warm worker (cold sessions self-compact on first resume; nothing for us
 *  to do externally). See `WorkerPool.compactIfWarm` for the lock semantics. */
export async function compactWarmSession(
  sessionKey: SessionKey,
  signal?: AbortSignal,
): Promise<import("./worker.ts").WorkerResult | null> {
  if (!workerPool) return null;
  return workerPool.compactIfWarm(sessionKey, signal);
}

// Anchored to this module's location, mirroring persona.ts. See the rationale there.
const SESSIONS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "persona",
  "sessions",
);

export type RunInput = {
  sessionKey: SessionKey;
  /** Already-built envelope text to feed as the user turn. */
  envelope: string;
  /** Pretty sender label used in system prompt ("Alex", "+15551234"). */
  senderLabel: string;
  /** Raw sender handle (for per-contact persona lookup). */
  senderHandle: string | null;
  /** Per-session scratch dir path. */
  sandboxPath: string;
  /**
   * Optional image paths to embed as multimodal content blocks on this
   * turn. Claude sees the pixels directly — no Read tool call required.
   * Used for inbound iMessage photos and for wake-ups that carry a
   * generated image (bg-job-done on generate_image, annotation submit).
   */
  images?: string[];
  /**
   * Depth of the inbound envelope this turn responds to. 0 = organic
   * iMessage; N = a relay arriving at depth N (see bridge/relay.ts).
   * Surfaced to MCP tools via EDMUND_INBOUND_DEPTH so `send_message` can
   * cap loop chains at MAX_RELAY_DEPTH.
   */
  inboundDepth?: number;
  /**
   * Browser-intent hint computed by the caller from the INBOUND BODY
   * only (the user's actual new messages). When set, it replaces the
   * envelope-wide regex — which matched URLs in history lines and the
   * auto-fetched link block, flipping the worker's browser binding with
   * whatever scrolled through the history window (383 of the last 400
   * worker recycles were that flip). Undefined = legacy whole-envelope
   * heuristic (ghost fires, cron wake-ups).
   */
  browserHint?: boolean;
  /**
   * Fine-grained typing signal — true when the model is currently
   * producing user-facing text (a text content block, or a `send_message`
   * tool_use whose `text` input is streaming), false otherwise (thinking,
   * tool calls, tool results, between-block gaps, end of turn).
   *
   * May fire many times per turn; the caller (TypingSession) is
   * idempotent so flipping back and forth is safe and the right thing
   * to do — bubble appears only while text is flowing.
   */
  onTyping?: (active: boolean) => void;
  /** Structural model phase driven by streamed thinking, tool, and text blocks. */
  onActivity?: (activity: ModelActivity, detail?: string) => void;
  /** Text deltas from the active assistant block, in model stream order. */
  onTextDelta?: (text: string) => void;
  /** Liveness heartbeat — fired on every stream event from the subprocess.
   *  Callers holding the session lock wire this to SessionLocks.touch so an
   *  actively-working turn keeps its lease for as long as the work takes. */
  onHeartbeat?: () => void;
  /** Cancels this exact turn, including its active Claude/tool process tree. */
  signal?: AbortSignal;
  /**
   * Force a truly fresh cold spawn — use a random session id instead of
   * the deterministic `deriveSessionId(sessionKey)`. Set by the turn
   * pipeline right after consuming a pending compaction so the new turn
   * starts with an empty JSONL instead of colliding on the derived id
   * (whose old, full JSONL is still on disk) and getting silently fed
   * back into `--resume` by the collision fallback — which defeats the
   * entire point of compaction.
   */
  freshSession?: boolean;
  /**
   * Guest-access tier for this session's sender, resolved by the turn
   * pipeline (src/guests/access.ts). Present ⇒ the worker gets the guest
   * loadout: core MCP server only (no integrations/radaromega/browser),
   * EDMUND_SESSION_TIER in the tool env (the MCP server registers a
   * reduced tool set), filesystem built-ins disallowed, and — for keyed
   * guests — the campaign context appended to the system prompt.
   * Undefined = full loadout, byte-identical to before guest access.
   */
  guest?: {
    tier: "keyed-guest" | "vouched";
    campaignKey: string | null;
    campaignContextPath: string | null;
  };
};

export type RunUsage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  /** Per-API-call usage — one entry per model round-trip in the turn's
   *  tool loop. The top-level fields above SUM these entries. */
  iterations?: IterationUsage[];
};

export type RunResult =
  | {
      ok: true;
      reply: string;
      claudeSessionId: string;
      usage?: RunUsage;
      /** Real context size of the turn — the largest single API call,
       *  measured from streamed assistant-event usage (fallback:
       *  contextTokens(usage)). Feed THIS to shouldCompact. */
      contextTokens?: number;
      totalCostUsd?: number;
    }
  | { ok: false; error: string; claudeSessionId?: string };

export { modelProfileForSession } from "../model/profile.ts";

export async function runClaude(
  rawInput: RunInput,
  config: Config,
  store: StateStore,
): Promise<RunResult> {
  // Guest-loadout safety net: when the caller didn't resolve a tier (the
  // recovery turn, cron fires, anything but the live turn pipeline), derive
  // it here so a guest session can NEVER be invoked with the full loadout.
  // "blocked" (revoked admission — expired campaign, kill switch) refuses
  // the turn outright instead of picking a loadout for it.
  let input = rawInput;
  if (!input.guest) {
    const derived = deriveGuestLoadout(input.sessionKey, config);
    if (derived === "blocked") {
      log.info("claude", "guest session blocked — turn refused", {
        session: input.sessionKey,
      });
      return { ok: false, error: "guest access revoked for this session; turn refused" };
    }
    if (derived) input = { ...input, guest: derived };
  }
  const existing = store.getSession(input.sessionKey);
  // Persona-edit auto-invalidation. The system prompt of a `--resume`d
  // session is whatever was baked in at first cold-spawn; later
  // --append-system-prompt content is concatenated but the model's
  // attention stays on the original. So when the operator (or the model
  // itself) edits IDENTITY/SOUL/VENUE_*, those changes don't actually
  // take effect on warm/resumed sessions until something forces a
  // cold-spawn. We track a fingerprint per session and trigger a fresh
  // spawn whenever it drifts. The old JSONL is orphaned (just a cache);
  // the model picks up the new prompt cleanly. `effectiveFreshSession`
  // OR's the caller's explicit request (post-compact) with this auto
  // detector — either path takes the freshSession code path below.
  //
  // Steady-state: when a recorded hash exists and differs from the
  // current one, force a cold-spawn this turn. Sessions with no
  // recorded hash yet (pre-feature or brand-new) just get the current
  // hash stamped as their baseline below — no migration spawn-storm.
  const currentFingerprint = personaFingerprint();
  const personaChanged =
    existing?.claudeSessionId != null &&
    existing.systemPromptHash != null &&
    existing.systemPromptHash !== currentFingerprint;
  if (personaChanged) {
    log.info("claude", "persona edit detected → cold-spawn this turn", {
      session: input.sessionKey,
      old_hash: existing?.systemPromptHash?.slice(0, 8),
      new_hash: currentFingerprint.slice(0, 8),
    });
    // Drop the stale session id so the spawn path uses a fresh cohort
    // and doesn't get pulled back into the old JSONL by the collision
    // fallback. The fresh cold-spawn re-bakes the new system prompt.
    store.setClaudeSessionId(input.sessionKey, null);
  }
  const effectiveFreshSession = input.freshSession === true || personaChanged;
  // Stamp the current fingerprint as the baseline for next turn. For
  // brand-new sessions where the row doesn't exist yet, this is a no-op
  // (UPDATE finds nothing); the row will be created by upsertSession in
  // turn.ts after the spawn, and the next turn will stamp then.
  if (existing && existing.systemPromptHash !== currentFingerprint) {
    store.setSystemPromptHash(input.sessionKey, currentFingerprint);
  }
  const mcpConfigs = ensureMcpConfig(config);
  // Pick the lighter mcp config (no chrome-devtools) by default; switch to
  // the browser-enabled one only when the turn looks like it'll need it.
  // Saves ~500-1500ms of Puppeteer cold-start on the ~70% of turns that
  // never touch a browser tool. The rebindKey below carries this choice so
  // a session that's been doing browser work stays warm-bound to a browser
  // worker across follow-ups.
  //
  // STICKY, UPGRADE-ONLY: if this session's warm worker already carries
  // the browser loadout, keep it for non-browser turns too — recycling
  // down throws away the warm Chrome AND the cached prompt prefix, then
  // the next URL recycles back up. Downgrade happens naturally when the
  // worker is idle-evicted.
  let needsBrowser = input.browserHint ?? envelopeNeedsBrowser(input.envelope);
  if (!needsBrowser && getPool(config)?.currentRebindKey(input.sessionKey)?.includes("browser=1")) {
    needsBrowser = true;
  }
  // Guest sessions never get the chrome-devtools loadout, whatever the
  // envelope looks like — their mcp config is the core server alone.
  const isGuest = input.guest != null;
  if (isGuest) needsBrowser = false;
  // Trading sessions always get the trading loadout (Robinhood tools), which
  // takes precedence over the browser heuristic.
  const isTrading = isTradingSession(input.sessionKey);
  const mcpConfigPath = isTrading
    ? mcpConfigs.trading
    : isGuest
      ? mcpConfigs.guest
      : needsBrowser
        ? mcpConfigs.withBrowser
        : mcpConfigs.default;
  // Named-orchestrator sessions carry their persona + model override; main
  // resolves to the synthetic builtin entry (no overrides), trading/cron to
  // null. A deleted config entry behind a live orch: session also resolves
  // null — the turn then runs with main's loadout rather than erroring.
  const orch = orchestratorForSession(input.sessionKey, config);
  const orchModel = orch && !orch.builtin && orch.model ? orch.model : null;
  const profile = modelProfileForSession(input.sessionKey, config, orchModel);

  // Prep multimodal attachments first — if any succeed, switch the Claude
  // input format from plain text to stream-json so we can pass image blocks
  // alongside the envelope text. Fall back to text-only when the list is
  // empty (or nothing survived prep, e.g. all files oversize/unsupported).
  const inlineCacheDir = join(input.sandboxPath, ".inline-images");
  if (input.images && input.images.length > 0) mkdirSync(inlineCacheDir, { recursive: true });
  const inlineImages = input.images ? prepareInlineImages(input.images, inlineCacheDir) : [];
  // The legacy spawn-per-turn path uses `--input-format text` when there are
  // no inline images (cheaper, simpler payload). The pool path can't use
  // text mode: `claude -p --input-format text` waits for stdin EOF before
  // processing, but a resident worker holds stdin open for the next turn,
  // so a text-mode worker would sit forever waiting for EOF. Force
  // stream-json input whenever the pool is on; that lets a single process
  // serve many user events on stdin (verified by the spike).
  const poolOn = config.claude.pool.enabled;
  const useStreamJsonInput = inlineImages.length > 0 || poolOn;

  const baseArgs: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    useStreamJsonInput ? "stream-json" : "text",
    "--verbose",
    // Partial-message events let us track exactly when the model is
    // generating user-facing text (vs thinking / tool calls / tool
    // results). The typing bubble lights up on `content_block_start` for
    // text or send_message tool_use, and goes dark on any other block
    // start or on `content_block_stop`. See worker.ts / runProcess.
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    // Workers must not spawn Claude Code subagents — the harness has its own
    // agent system (spawn_agent/spawn_team) with tracking and completion
    // events. This replaces the old ~/.claude/settings.json `Deny(Task)`
    // rule, which was malformed (matched no tool) and only produced stderr
    // warnings on every worker spawn.
    //
    // Guest sessions additionally lose every filesystem/shell built-in:
    // Read is unrestricted by the PreToolUse guard (which only covers
    // writes), so a guest-prompted injection could otherwise read anything
    // on this Mac. Inbound images still work (they're inlined as content
    // blocks) and web/generation/voice tools stay. ToolSearch stays too —
    // it's how deferred MCP schemas load.
    "--disallowedTools",
    disallowedBuiltinTools(hostAccess(config), isGuest),
    "--model",
    profile.model,
    "--effort",
    profile.effort,
    "--mcp-config",
    mcpConfigPath,
    // Load ONLY the servers in the chosen config file — do not inherit
    // user/project-scoped MCP servers from ~/.claude.json. This is what keeps
    // the Robinhood MCP OUT of the edmund persona (its mcp.json has no
    // Robinhood server) and scoped to trading sessions only (mcp-trading.json
    // adds it explicitly). Deterministic regardless of cwd / registration scope.
    "--strict-mcp-config",
    "--append-system-prompt",
    buildRunSystemPrompt(input, config, orch),
  ];

  const env = toolEnv(
    config,
    input.sessionKey,
    input.sandboxPath,
    input.inboundDepth ?? 0,
    input.guest?.tier ?? null,
  );
  const timeoutMs = config.claude.timeout_seconds * 1000;
  const stdinPayload = useStreamJsonInput
    ? buildStreamJsonInput(input.envelope, inlineImages)
    : input.envelope;
  // Only log when there's actually multimodal content. With the pool on,
  // useStreamJsonInput is always true (see comment above) — emitting on
  // every turn produced 487 "images=0 sources=[]" no-op lines in the
  // sample log window. Keep the line for image-bearing turns where it
  // carries real info.
  if (inlineImages.length > 0) {
    log.info("claude", "multimodal input", {
      session: input.sessionKey,
      images: inlineImages.length,
      sources: inlineImages.map((i) => i.sourcePath),
    });
  }

  // Redirect Claude Code's per-project session dir (normally under ~/.claude)
  // into persona/sessions/ so transcripts live with the rest of the harness.
  ensureSessionLink(input.sandboxPath, SESSIONS_ROOT);

  // Bad persisted tool ids (provider-translated "Bash:0" style) are now
  // repaired REACTIVELY — the `bad_tool_ids` healer runs the rewrite when
  // the API actually rejects one, then evicts the warm worker so the fix
  // takes effect. The unconditional pre-resume walk that lived here read
  // and parsed the full session JSONL on every turn (~420ms of blocked
  // event loop at 200MB) and found zero bad ids in production; with the
  // pool on it was also ineffective for warm sessions, whose resident
  // process never re-reads the file.

  // Cold spawns ALWAYS use a fresh random UUID. The old design used a
  // deterministic id from `deriveSessionId(sessionKey)` so the JSONL was
  // stable across restarts without state.db. But that created a class of
  // bugs: any time the session id was force-cleared (operator SQL,
  // post-compact, persona invalidation, fresh DB) and the prior JSONL
  // was still on disk, the cold spawn collided with itself and
  // `coldStartWithCollisionFallback` silently `--resume`'d the stale
  // file — defeating every compact and every prompt invalidation.
  // Random UUIDs avoid the collision entirely; resume-ability comes from
  // the claude_session_id we persist after a successful cold spawn.
  const derivedId = crypto.randomUUID();
  if (effectiveFreshSession) {
    log.info("claude", "fresh session id (cold start)", {
      session: input.sessionKey,
      new_id: derivedId.slice(0, 8),
      reason: input.freshSession ? "post-compact" : "persona-edit",
    });
  }

  // Pool-routed path: when the resident worker pool is enabled, attempts
  // go through the pool. Healer + cold-start logic is mirrored from the
  // legacy spawn-per-turn path below so the failure-recovery behavior is
  // identical regardless of execution mode. The pool decides whether the
  // worker is fresh or reused.
  const pool = getPool(config);
  if (pool) {
    return runViaPool({
      input,
      config,
      store,
      pool,
      baseArgs,
      env,
      stdinPayload,
      useStreamJsonInput,
      needsBrowser,
      derivedId,
      existingSessionId: existing?.claudeSessionId ?? null,
    });
  }

  const legacyOnTyping = (active: boolean) => {
    try {
      input.onTyping?.(active);
    } catch (err) {
      log.warn("claude", "onTyping threw", {
        session: input.sessionKey,
        err: (err as Error).message,
      });
    }
  };
  const legacyOnActivity = (activity: ModelActivity, detail?: string) => {
    try {
      input.onActivity?.(activity, detail);
    } catch (err) {
      log.warn("claude", "onActivity threw", {
        session: input.sessionKey,
        err: (err as Error).message,
      });
    }
  };
  const legacyOnTextDelta = (text: string) => {
    try {
      input.onTextDelta?.(text);
    } catch (err) {
      log.warn("claude", "onTextDelta threw", {
        session: input.sessionKey,
        err: (err as Error).message,
      });
    }
  };
  const attempt = async (sessionArgs: string[]): Promise<RunResult> =>
    runProcess(
      [...baseArgs, ...sessionArgs],
      stdinPayload,
      env,
      timeoutMs,
      legacyOnTyping,
      legacyOnActivity,
      legacyOnTextDelta,
      input.signal,
      input.onHeartbeat,
    );

  // Happy path: resume the prior Claude session if we have one. Preventive
  // compaction is deferred to AFTER the turn so it never lands on the
  // user-visible latency path — the current turn succeeds even at the soft
  // limit; only the *next* turn risks hitting the hard limit, and the
  // post-turn pass takes care of that. See `schedulePostTurnCompact` below.
  if (existing?.claudeSessionId) {
    const result = await attempt(["--resume", existing.claudeSessionId]);
    if (result.ok) {
      store.clearError(input.sessionKey);
      // Fire-and-forget: the next turn won't start until handleBatchInner
      // finishes its sendDeliver, so this has time to complete off the hot
      // path. setImmediate so we don't block the return either.
      setImmediate(() =>
        maybePreventiveCompact(input.sandboxPath, result.claudeSessionId, input.sessionKey),
      );
      return result;
    }
    if (input.signal?.aborted) return result;

    // Classify and apply the matching healer + retry once. The recovery
    // sweeper handles the out-of-band case (no retry happened, daemon
    // crashed mid-turn, etc.) so we don't need a second retry layer here.
    const cls = classifyError(result.error);
    store.recordError(input.sessionKey, cls, Date.now());
    const healer = HEALERS[cls];
    if (healer) {
      try {
        const heal = await healer(input.sessionKey, {
          state: store,
          sandboxPath: input.sandboxPath,
        });
        log.info("claude", "in-band heal", {
          session: input.sessionKey,
          err_class: cls,
          ok: heal.ok,
          changed: heal.changed,
          detail: heal.detail,
        });
        if (heal.ok && cls === "stale_session_id") {
          // Healer just cleared claudeSessionId. Cold-start.
          return coldStartWithCollisionFallback(attempt, derivedId);
        }
        if (heal.ok && heal.changed) {
          const retry = await attempt(["--resume", existing.claudeSessionId]);
          if (retry.ok) {
            store.clearError(input.sessionKey);
            return retry;
          }
          return retry;
        }
      } catch (err) {
        log.warn("claude", "in-band heal threw", {
          session: input.sessionKey,
          err: (err as Error).message,
        });
      }
    }
    return result;
  }

  const cold = await coldStartWithCollisionFallback(attempt, derivedId);
  if (input.signal?.aborted) return cold;
  if (cold.ok) {
    store.clearError(input.sessionKey);
    setImmediate(() =>
      maybePreventiveCompact(input.sandboxPath, cold.claudeSessionId, input.sessionKey),
    );
  } else {
    store.recordError(input.sessionKey, classifyError(cold.error), Date.now());
  }
  return cold;
}

/**
 * Pool-routed execution path. Mirrors the legacy runProcess path's
 * resume/cold-start/healer logic, but every "attempt" goes through the
 * WorkerPool — which decides whether to reuse a warm worker or spawn one.
 *
 * The trick: per the spike, `claude -p --input-format stream-json` accepts
 * MULTIPLE user events on stdin and reuses the underlying session, with
 * Anthropic prompt caching kicking in across turns within the same worker.
 * So once a worker is warm, subsequent turns are dramatically faster — the
 * cold-start cost is amortized across the entire conversation.
 *
 * On error → healer succeeds → we recycle the worker (since healing usually
 * mutates the on-disk session JSONL, which the worker has open). The pool's
 * `evict` shuts the worker down cleanly; the next `run()` call respawns.
 */
async function runViaPool(args: {
  input: RunInput;
  config: Config;
  store: StateStore;
  pool: WorkerPool;
  baseArgs: string[];
  env: Record<string, string>;
  stdinPayload: string;
  useStreamJsonInput: boolean;
  needsBrowser: boolean;
  derivedId: string;
  existingSessionId: string | null;
}): Promise<RunResult> {
  const {
    input,
    store,
    pool,
    baseArgs,
    env,
    stdinPayload,
    useStreamJsonInput,
    needsBrowser,
    derivedId,
  } = args;
  // Forward typing signals directly. The pool path may attempt multiple
  // times (resume → heal → retry); each attempt's typing transitions are
  // valid signals for the caller, no de-dup needed.
  const onTyping = (active: boolean) => {
    try {
      input.onTyping?.(active);
    } catch (err) {
      log.warn("claude", "onTyping threw", {
        session: input.sessionKey,
        err: (err as Error).message,
      });
    }
  };
  const onActivity = (activity: ModelActivity, detail?: string) => {
    try {
      input.onActivity?.(activity, detail);
    } catch (err) {
      log.warn("claude", "onActivity threw", {
        session: input.sessionKey,
        err: (err as Error).message,
      });
    }
  };
  const onTextDelta = (text: string) => {
    try {
      input.onTextDelta?.(text);
    } catch (err) {
      log.warn("claude", "onTextDelta threw", {
        session: input.sessionKey,
        err: (err as Error).message,
      });
    }
  };
  const payload: WorkerTurn = {
    stdinPayload,
    onTyping,
    onActivity,
    onTextDelta,
    // No try/catch wrapper: SessionLocks.touch never throws, and the worker
    // guards the call site anyway (it fires on every stdout chunk).
    onHeartbeat: input.onHeartbeat,
    signal: input.signal,
  };

  // The rebind key locks in spawn-time properties. If any of these change,
  // the worker can't be reused — the pool will recycle it. Per-turn things
  // that DON'T appear here (envelope text, the user's message, the sender
  // identity in groups) flow through stdin events into the warm worker.
  //
  // Sender deliberately not in the rebind key: the system prompt is built
  // session-stably (see buildSystemPrompt — group prompts omit sender; DM
  // sender is constant). Including it would force a rebind every time a
  // different group member talked, defeating the pool's whole point.
  const rebindKey = [
    input.sandboxPath,
    `depth=${input.inboundDepth ?? 0}`,
    `images=${useStreamJsonInput ? "stream-json" : "text"}`,
    // Browser MCP set is part of the worker's spawn-time mcp-config — different
    // selection means a different child-process tree, so it must rebind. Once
    // a session goes browser=true, subsequent browser turns reuse the warm
    // Chrome connection (the real win); non-browser turns will rebind to the
    // lighter config, which is a one-time cost.
    `browser=${needsBrowser ? "1" : "0"}`,
    // Trading workers load a different mcp-config (Robinhood tools) and a
    // different persona/system prompt, so they must never be reused for a
    // non-trading session or vice-versa. (The sandbox path already differs,
    // but make the discriminator explicit.)
    `trading=${isTradingSession(input.sessionKey) ? "1" : "0"}`,
    // Guest tier + campaign are spawn-time properties (mcp config, tool
    // env, system prompt). A handle promoted guest→allowlisted — or a
    // campaign swap — must recycle the worker, not inherit the old loadout.
    `guest=${input.guest ? `${input.guest.tier}:${input.guest.campaignKey ?? ""}` : "0"}`,
    // A flip of [security].model_host_access must respawn: the disallowed
    // tool list is fixed at spawn time.
    `host=${baseArgs[baseArgs.indexOf("--disallowedTools") + 1] ?? "?"}`,
    `model=${baseArgs[baseArgs.indexOf("--model") + 1] ?? "?"}`,
    `effort=${baseArgs[baseArgs.indexOf("--effort") + 1] ?? "?"}`,
  ].join("|");

  const perTurnIdleMs = args.config.claude.timeout_seconds * 1000;

  const spawnFor = (sessionArgs: string[]): WorkerSpawnArgs => ({
    argv: [...baseArgs, ...sessionArgs],
    env,
    cwd: input.sandboxPath,
    perTurnIdleMs,
    sessionKey: input.sessionKey,
  });

  const attempt = async (sessionArgs: string[]): Promise<RunResult> => {
    const res = await pool.run({
      sessionKey: input.sessionKey,
      rebindKey,
      spawn: spawnFor(sessionArgs),
      payload,
    });
    return workerResultToRunResult(res);
  };

  // Resume the prior session if we have one. (Reusing a warm worker means
  // `--resume` is paid only on the FIRST turn of that worker's life.)
  if (args.existingSessionId) {
    const result = await attempt(["--resume", args.existingSessionId]);
    if (result.ok) {
      store.clearError(input.sessionKey);
      // Compaction is deferred until the worker is evicted — see the
      // pool.evict path. Running it now would race with the worker's open
      // file handle on the session JSONL.
      return result;
    }
    if (input.signal?.aborted) return result;

    const cls = classifyError(result.error);
    store.recordError(input.sessionKey, cls, Date.now());
    const healer = HEALERS[cls];
    if (healer) {
      try {
        const heal = await healer(input.sessionKey, {
          state: store,
          sandboxPath: input.sandboxPath,
        });
        log.info("claude", "in-band heal (pool)", {
          session: input.sessionKey,
          err_class: cls,
          ok: heal.ok,
          changed: heal.changed,
          detail: heal.detail,
        });
        if (heal.ok && heal.changed) {
          // The healer mutated on-disk state; the warm worker is now
          // stale. Recycle it so the retry gets a fresh process.
          await pool.evict(input.sessionKey, "post-heal recycle");
        }
        if (heal.ok && cls === "stale_session_id") {
          return coldStartViaPool(attempt, derivedId);
        }
        if (heal.ok && heal.changed) {
          const retry = await attempt(["--resume", args.existingSessionId]);
          if (retry.ok) store.clearError(input.sessionKey);
          return retry;
        }
      } catch (err) {
        log.warn("claude", "in-band heal threw (pool)", {
          session: input.sessionKey,
          err: (err as Error).message,
        });
      }
    }
    return result;
  }

  const cold = await coldStartViaPool(attempt, derivedId);
  if (input.signal?.aborted) return cold;
  if (cold.ok) store.clearError(input.sessionKey);
  else store.recordError(input.sessionKey, classifyError(cold.error), Date.now());
  return cold;
}

async function coldStartViaPool(
  attempt: (args: string[]) => Promise<RunResult>,
  derivedId: string,
): Promise<RunResult> {
  const result = await attempt(["--session-id", derivedId]);
  if (result.ok) return result;
  if (isSessionInUseError(result.error)) {
    log.warn("claude-pool", "derived session already on disk; resuming", {
      session_id: derivedId,
    });
    return attempt(["--resume", derivedId]);
  }
  return result;
}

function workerResultToRunResult(r: WorkerResult): RunResult {
  if (r.ok) {
    return {
      ok: true,
      reply: r.reply,
      claudeSessionId: r.claudeSessionId,
      usage: r.usage,
      contextTokens: r.contextTokens,
      totalCostUsd: r.totalCostUsd,
    };
  }
  return { ok: false, error: r.error, claudeSessionId: r.claudeSessionId };
}

function maybePreventiveCompact(
  sandboxPath: string,
  sessionId: string,
  sessionKey: SessionKey,
): void {
  // A resident worker has the session JSONL open for append; rewriting it
  // mid-flight risks a race where the worker writes a partial line over
  // freshly compacted state. Skip — the pool's eviction path is the right
  // place to compact, and an idle worker will be evicted within ~10 min.
  if (hasResidentWorker(sessionKey)) {
    log.debug("claude", "skipping compact: worker resident", { session: sessionKey });
    return;
  }
  try {
    const path = sessionFilePath(sandboxPath, sessionId);
    const result = compactSession(path, TARGET_AFTER_COMPACT);
    if (result.changed) {
      log.info("claude", "session compacted (preventive)", {
        session: sessionKey,
        before: result.beforeBytes,
        after: result.afterBytes,
        images_compacted: result.imagesCompacted,
        total_images: result.totalImages,
      });
    } else if (result.beforeBytes > SESSION_SIZE_SOFT_LIMIT) {
      // File is over the soft limit but compactSession didn't change
      // anything (e.g. it's already below TARGET_AFTER_COMPACT, or there
      // are no compactable images). Nothing to do.
    }
  } catch (err) {
    log.warn("claude", "preventive compact failed", {
      session: sessionKey,
      err: (err as Error).message,
    });
  }
}

async function coldStartWithCollisionFallback(
  attempt: (args: string[]) => Promise<RunResult>,
  derivedId: string,
): Promise<RunResult> {
  const result = await attempt(["--session-id", derivedId]);
  if (result.ok) return result;
  if (isSessionInUseError(result.error)) {
    // A prior run created this session on disk but errored before we could
    // persist the id. Pick up where it left off instead of colliding.
    log.warn("claude", "derived session already on disk; resuming", {
      session_id: derivedId,
    });
    return attempt(["--resume", derivedId]);
  }
  return result;
}

function isSessionInUseError(msg: string): boolean {
  return /already in use/i.test(msg);
}

function deriveSessionId(sessionKey: SessionKey): string {
  const hash = new Bun.CryptoHasher("sha256").update(sessionKey).digest("hex") as string;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

type ContentBlock =
  | { type: "text"; text?: string }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

/** Model/provider Claude Code reports for the `result` log line. */
function formatModel(model: string): Record<string, unknown> {
  if (!model) return {};
  return { model, provider: "anthropic" };
}

type ClaudeEvent =
  | { type: "system"; subtype: "init"; session_id: string; model?: string }
  | {
      type: "assistant";
      message: { content: Array<ContentBlock>; model?: string; usage?: RunUsage };
      /** Set on in-process subagent streams — their usage describes the
       *  subagent's context, not this session's. */
      parent_tool_use_id?: string | null;
    }
  | { type: "user"; message: { content: Array<ContentBlock> } }
  | {
      type: "result";
      subtype: "success" | "error";
      result?: string;
      is_error?: boolean;
      usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
        /** Per-API-call usage; the top-level fields sum these. */
        iterations?: IterationUsage[];
      };
      total_cost_usd?: number;
    }
  | {
      type: "stream_event";
      event: {
        type: string;
        content_block?: { type: string; name?: string };
        delta?: { type?: string; text?: string };
      };
    };

function runProcess(
  args: string[],
  input: string,
  env: Record<string, string>,
  timeoutMs: number,
  onTyping?: (active: boolean) => void,
  onActivity?: (activity: ModelActivity, detail?: string) => void,
  onTextDelta?: (text: string) => void,
  signal?: AbortSignal,
  onHeartbeat?: () => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    // cwd = sandbox: relative paths the model writes default into the
    // session's own directory. Absolute escapes are blocked by the
    // PreToolUse hook (scripts/guard-path.ts).
    const cwd = env.EDMUND_SANDBOX_PATH;
    const sessionKey = env.EDMUND_SESSION_KEY ?? "?";
    const resumeArg = args.indexOf("--resume");
    const isResume = resumeArg !== -1;
    const started = Date.now();
    log.info("claude", "spawn", {
      session: sessionKey,
      mode: isResume ? "resume" : "cold",
      sessionId: isResume ? args[resumeArg + 1] : undefined,
      input_chars: input.length,
    });
    log.debug("claude", "spawn args", { argv: args });
    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd,
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let sessionId = "";
    let lastAssistantText = "";
    let respModel = "";
    let settled = false;
    let toolUseCount = 0;
    let maxCallContextTokens = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      terminateProcessTree(proc.pid, "SIGTERM");
      resolve(r);
    };
    const onAbort = () => {
      const reason =
        typeof signal?.reason === "string" && signal.reason.trim()
          ? signal.reason.trim().slice(0, 160)
          : "superseded by user";
      finish({
        ok: false,
        error: `turn interrupted: ${reason}`,
        claudeSessionId: sessionId || undefined,
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    // Idle timeout: the timer is reset every time we see stdout activity
    // (any streamed event from the model). A long-but-active turn — e.g. a
    // tool call doing a multi-minute investigation — stays alive; only a
    // truly hung process (no events for `timeoutMs`) gets killed.
    const armIdleTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () =>
          finish({ ok: false, error: `idle timeout after ${timeoutMs}ms (no stream activity)` }),
        timeoutMs,
      );
    };
    armIdleTimer();

    // Typing state machine, driven by content_block_start/stop events the
    // CLI emits when `--include-partial-messages` is on. Matches the rule
    // used by the resident-worker path: typing ON only while the model
    // is actively producing user-facing text (a text block, or a
    // `send_message` tool_use whose text input is streaming). Idempotent
    // — onTyping is only fired on actual transitions.
    let typingActive = false;
    const setTyping = (active: boolean) => {
      if (typingActive === active) return;
      typingActive = active;
      try {
        onTyping?.(active);
      } catch (err) {
        log.warn("claude", "onTyping threw", {
          session: sessionKey,
          err: (err as Error).message,
        });
      }
    };
    let activity: ModelActivity | null = null;
    let hasStreamedText = false;
    let textBlockNeedsSeparator = false;
    const setActivity = (next: ModelActivity) => {
      if (activity === next) return;
      activity = next;
      try {
        onActivity?.(next);
      } catch (err) {
        log.warn("claude", "onActivity threw", {
          session: sessionKey,
          err: (err as Error).message,
        });
      }
    };
    proc.stdout.on("data", (chunk) => {
      armIdleTimer();
      try {
        onHeartbeat?.();
      } catch {
        // Never let a heartbeat listener break stream parsing.
      }
      stdout += chunk.toString();
      let nl = stdout.indexOf("\n");
      while (nl !== -1) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        nl = stdout.indexOf("\n");
        if (!line) continue;
        let evt: ClaudeEvent;
        try {
          evt = JSON.parse(line) as ClaudeEvent;
        } catch {
          continue;
        }
        if (evt.type === "stream_event") {
          const se = evt.event;
          if (se.type === "content_block_start" && se.content_block) {
            const cb = se.content_block;
            const isUserText =
              cb.type === "text" || (cb.type === "tool_use" && cb.name === "send_message");
            if (cb.type === "text") {
              textBlockNeedsSeparator = hasStreamedText;
            }
            setActivity(modelActivityForBlock(cb.type, cb.name));
            setTyping(isUserText);
          } else if (
            se.type === "content_block_delta" &&
            se.delta?.type === "text_delta" &&
            typeof se.delta.text === "string"
          ) {
            onTextDelta?.(textDeltaForBlock(se.delta.text, textBlockNeedsSeparator));
            textBlockNeedsSeparator = false;
            hasStreamedText = true;
          } else if (se.type === "content_block_stop" || se.type === "message_stop") {
            setTyping(false);
          }
          continue;
        }
        if (evt.type === "system" && evt.subtype === "init") {
          sessionId = evt.session_id;
          log.debug("claude", "stream init", {
            session: sessionKey,
            sessionId,
            model: evt.model,
          });
        } else if (evt.type === "assistant") {
          if (evt.message.model) respModel = evt.message.model;
          // Per-call context tracking: each assistant event carries its
          // API call's own usage (repeated per content block — max()
          // makes repeats harmless). Skip subagent streams.
          if (!evt.parent_tool_use_id && evt.message.usage) {
            maxCallContextTokens = Math.max(
              maxCallContextTokens,
              iterationContextTokens(evt.message.usage),
            );
          }
          const blocks = evt.message.content;
          for (const block of blocks) {
            setActivity(
              modelActivityForBlock(
                block.type,
                block.type === "tool_use" && typeof block.name === "string"
                  ? block.name
                  : undefined,
              ),
            );
          }
          const text = blocks
            .filter((b): b is { type: "text"; text?: string } => b.type === "text")
            .map((b) => b.text ?? "")
            .join("")
            .trim();
          if (text) lastAssistantText = text;
          // Log tool_use events so audit trail shows what the model called
          // mid-turn (skills, send_message, spawn_agent, schedule_reminder, etc.).
          for (const b of blocks) {
            if (b.type === "tool_use") {
              toolUseCount++;
              const tu = b as { name?: string; id?: string; input?: unknown };
              log.info("claude", "tool_use", {
                session: sessionKey,
                name: tu.name,
                id: tu.id,
                input_summary: summarizeToolInput(tu.input),
              });
              log.debug("claude", "tool_use input-full", {
                session: sessionKey,
                name: tu.name,
                input: tu.input,
              });
            }
          }
        } else if (evt.type === "user") {
          // Tool results come back as role=user with tool_result blocks.
          for (const b of evt.message.content) {
            if (b.type === "tool_result") {
              setActivity("thinking");
              if (!DEBUG) continue;
              const tr = b as { tool_use_id?: string; is_error?: boolean; content?: unknown };
              log.debug("claude", "tool_result", {
                session: sessionKey,
                tool_use_id: tr.tool_use_id,
                is_error: tr.is_error,
                preview: snippet(summarizeToolResult(tr.content), 160),
              });
            }
          }
        } else if (evt.type === "result") {
          // Turn ended — typing off regardless of whether a stream
          // content_block_stop already fired (defensive).
          setTyping(false);
          clearTimeout(timer);
          if (evt.is_error) {
            const detail = evt.result?.trim() || stderr.trim() || "claude returned error";
            log.error("claude", "result error", {
              session: sessionKey,
              dur: humanMs(Date.now() - started),
              ...formatModel(respModel),
              tools: toolUseCount,
              err: snippet(detail, 200),
            });
            finish({ ok: false, error: detail, claudeSessionId: sessionId || undefined });
          } else {
            // An empty reply isn't an error — the model may have done the
            // user's bidding entirely via tool calls (e.g. send_attachment)
            // and has nothing left to say. We send no text reply in that
            // case but still treat the run as a success so state persists.
            const reply = (evt.result ?? lastAssistantText).trim();
            const u = evt.usage;
            const cacheRead = u?.cache_read_input_tokens ?? 0;
            const cacheCreate = u?.cache_creation_input_tokens ?? 0;
            const inputTokens = u?.input_tokens ?? 0;
            const cacheable = cacheRead + cacheCreate + inputTokens;
            const hitPct = cacheable > 0 ? Math.round((cacheRead / cacheable) * 100) : 0;
            const ctxTokens = maxCallContextTokens > 0 ? maxCallContextTokens : contextTokens(u);
            log.info("claude", "result ok", {
              session: sessionKey,
              dur: humanMs(Date.now() - started),
              ...formatModel(respModel),
              tools: toolUseCount,
              reply_chars: reply.length,
              in: inputTokens,
              out: u?.output_tokens ?? 0,
              cache_read: cacheRead,
              cache_create: cacheCreate,
              // Largest single API call — the auto-compact signal. The
              // cache_* fields sum every round-trip in the tool loop.
              ctx: humanCount(ctxTokens),
              cache_hit: `${hitPct}%`,
              ...(typeof evt.total_cost_usd === "number"
                ? { cost_usd: evt.total_cost_usd.toFixed(4) }
                : {}),
            });
            finish({
              ok: true,
              reply,
              claudeSessionId: sessionId,
              usage: u,
              contextTokens: ctxTokens,
              totalCostUsd: evt.total_cost_usd,
            });
          }
        }
      }
    });

    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        finish({
          ok: false,
          error:
            code === 0
              ? "claude exited without result event"
              : `claude exit ${code}: ${stderr.trim()}`,
        });
      }
    });

    proc.stdin.end(input);
  });
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

/**
 * One-liner summary of a tool-use input — first ~3 fields with truncated
 * values. Full input is in the DEBUG line below. Keeps the info-level
 * log scannable even for tools with big string args.
 */
function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return String(input).slice(0, 80);
  const entries = Object.entries(input as Record<string, unknown>);
  const parts = entries.slice(0, 3).map(([k, v]) => {
    if (typeof v === "string") {
      const clean = v.replace(/\s+/g, " ").trim();
      const shown = clean.length > 60 ? `${clean.slice(0, 60)}…(len=${clean.length})` : clean;
      return `${k}=${shown}`;
    }
    if (Array.isArray(v)) return `${k}=[${v.length}]`;
    if (typeof v === "object" && v !== null) return `${k}={obj}`;
    return `${k}=${v}`;
  });
  return parts.join(" ") + (entries.length > 3 ? ` (+${entries.length - 3} more)` : "");
}

/**
 * Build the single stream-json line that carries a multimodal user turn.
 * The envelope text goes first so the model reads the framing before the
 * image(s). Content block order matters a little — some models pay more
 * attention to material earlier in the content array.
 */
function buildStreamJsonInput(envelope: string, images: InlineImage[]): string {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: envelope }];
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    });
  }
  const msg = { type: "user", message: { role: "user", content } };
  return `${JSON.stringify(msg)}\n`;
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part)
          return String((part as { text?: string }).text ?? "");
        return JSON.stringify(part);
      })
      .join(" ");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
