import { resolve } from "node:path";
import { shouldCompact } from "../claude/auto-compact.ts";
import { type RunInput, type RunResult, evictWarmWorker, runClaude } from "../claude/runner.ts";
import { runCodex } from "../codex/runner.ts";
import type { Config } from "../config/config.ts";
import { pausedReason } from "../security/watch/state.ts";
import type { SessionKey } from "../sessions/key.ts";
import { endScreenHold, screenLockPath } from "../sessions/screen-lock.ts";
import type { StateStore } from "../sessions/store.ts";
import { noteTurnStart } from "../sessions/turn-origin.ts";
import { log } from "../util/log.ts";
import { type ModelBackend, backendForModel, transitionModelSession } from "./backend.ts";
import { classifyError } from "./failure-class.ts";
import { modelProfileForSession } from "./profile.ts";

export type ModelRunResult = RunResult & { backend: ModelBackend };

type CompactConfig = { enabled: boolean; threshold_tokens: number };

/**
 * The compact/re-anchor thresholds, resolved per backend.
 *
 * Claude compacts in place and Codex re-anchors, but until now both read
 * `[claude] auto_compact.threshold_tokens` — so the number tuned against a
 * 1m Claude window also decided when a 272k Codex thread was thrown away.
 * `[codex] threshold_tokens` overrides it; unset keeps the old behaviour.
 */
export function compactConfigFor(backend: ModelBackend, config: Config): CompactConfig {
  const base = config.claude.auto_compact;
  if (backend !== "codex") return base;
  return { ...base, threshold_tokens: config.codex.threshold_tokens ?? base.threshold_tokens };
}

/** Persistent Codex threads have no harness-invokable `/compact`. */
export function shouldReanchorCodex(result: ModelRunResult, compactConfig: CompactConfig): boolean {
  return (
    result.ok &&
    result.backend === "codex" &&
    shouldCompact(result.usage, compactConfig, result.contextTokens)
  );
}

/**
 * Apply the Codex context bound for non-channel invocations (cron,
 * proactive, recovery). Inbound channel turns defer this until after delivery
 * so coalescing can finish on the current native thread.
 */
export function reanchorCodexIfNeeded(
  result: ModelRunResult,
  compactConfig: CompactConfig,
  store: StateStore,
  sessionKey: RunInput["sessionKey"],
): boolean {
  if (!shouldReanchorCodex(result, compactConfig)) return false;
  store.setModelSession(sessionKey, null, "codex");
  log.info("auto-compact", "codex thread re-anchored — next turn starts cold", {
    session: sessionKey,
    context: result.ok ? result.contextTokens : undefined,
    threshold: compactConfig.threshold_tokens,
  });
  return true;
}

/**
 * A turn that used the screen gives it up when it ends, and its computer-use
 * server quits the apps it opened (sessions/screen-lock.ts). Every turn,
 * whatever started it and whichever backend ran it, ends in runModel.
 */
export function releaseScreen(config: Config, sessionKey: string): void {
  try {
    const outcome = endScreenHold(screenLockPath(resolve(config.paths.data_dir)), sessionKey);
    if (outcome === "signalled") {
      log.info("computer", "turn ended; releasing the screen", { session: sessionKey });
    } else if (outcome === "cleared") {
      log.info("computer", "turn ended; cleared a screen lock whose server had exited", {
        session: sessionKey,
      });
    }
  } catch (err) {
    log.warn("computer", "could not release the screen", {
      session: sessionKey,
      err: (err as Error).message,
    });
  }
}

/**
 * A turn is starting: record what started it for the computer-use safety
 * check (sessions/turn-origin.ts), which cannot otherwise tell a message that
 * arrived during a scheduled turn from one that started a turn of its own.
 */
export function noteScreenTurn(config: Config, sessionKey: string, cronJob: string | null): void {
  if (!config.computer_use?.enabled) return;
  try {
    noteTurnStart(resolve(config.paths.data_dir), sessionKey, cronJob);
  } catch (err) {
    log.warn("computer", "could not record what started the turn", {
      session: sessionKey,
      err: (err as Error).message,
    });
  }
}

/**
 * A thread the provider refused is never resumed again. Resuming re-sends the
 * same history, which is what was judged, so it fails the same way every time
 * (Codex: 10 of 10 on 2026-10-02, recovery retrying it every 30 minutes for
 * 3h+; Claude: four turns running on 2026-10-23). Forget the stored id so the
 * next turn cold-starts with the recent chat, and strip it from the result:
 * callers persist a failed turn's thread id, which would put the refused
 * thread straight back. A warm Claude worker goes too: it holds the refused
 * history in memory, and the pool reuses a session's worker whatever id the
 * next spawn asks for.
 *
 * No retry here: this turn's envelope was built for a resume and carries no
 * history, so a cold retry would answer without the conversation. Recovery
 * answers on the fresh thread, with the recent chat in its envelope.
 */
export async function dropRefusedThread(
  result: RunResult,
  priorId: string | null,
  store: Pick<StateStore, "setModelSession">,
  sessionKey: SessionKey,
  backend: ModelBackend,
): Promise<RunResult> {
  if (result.ok || classifyError(result.error) !== "thread_refused") return result;
  log.warn("model", "provider refused the thread — next turn starts a fresh one", {
    session: sessionKey,
    backend,
    thread_id: result.claudeSessionId ?? priorId ?? undefined,
  });
  if (backend === "claude") await evictWarmWorker(sessionKey, "provider refused the thread");
  store.setModelSession(sessionKey, null, backend);
  return { ok: false, error: result.error };
}

/** The model a session runs on, and which CLI that model belongs to. */
function sessionModel(sessionKey: SessionKey, config: Config) {
  const profile = modelProfileForSession(sessionKey, config);
  return { profile, backend: backendForModel(profile.model) };
}

/** What runModel will do with this session's stored model conversation. */
function sessionTransition(sessionKey: SessionKey, config: Config, store: StateStore) {
  const { profile, backend } = sessionModel(sessionKey, config);
  const existing = store.getSession(sessionKey);
  const transition = transitionModelSession(
    {
      sessionId: existing?.claudeSessionId ?? null,
      backend: existing?.sessionBackend ?? null,
    },
    backend,
  );
  return { profile, backend, transition };
}

/**
 * Whether runModel will start this session without its model conversation:
 * nothing stored, or a provider switch that drops it. The inbound pipeline
 * decides this for itself before it builds its envelope. Turns that build
 * their own envelope (scheduled events, proactive fires) ask here, so a cold
 * start carries the recent thread instead of only the event text.
 */
export function startsCold(sessionKey: SessionKey, config: Config, store: StateStore): boolean {
  return sessionTransition(sessionKey, config, store).transition.sessionId === null;
}

/**
 * Shared turn entry point. Model selection remains where it always was in
 * config; only the effective model name decides which installed CLI runs it.
 */
export async function runModel(
  rawInput: RunInput,
  config: Config,
  store: StateStore,
): Promise<ModelRunResult> {
  // A chat the security watch paused starts no turn until the operator
  // answers the alert (OK or UNDO) or runs `edmund watch resume`. Worded so
  // that no caller reads it as an outage to alert on or a failure to retry.
  const paused = pausedReason(config.paths.data_dir, rawInput.sessionKey);
  if (paused) {
    log.warn("model", "turn not started: chat paused by the security watch", {
      session: rawInput.sessionKey,
    });
    return {
      ok: false,
      error: "This chat is paused by the security watch until the operator answers its alert.",
    } as ModelRunResult;
  }

  const { profile, backend, transition } = sessionTransition(rawInput.sessionKey, config, store);

  let input = rawInput;
  if (transition.switched) {
    if (transition.priorBackend === "claude") {
      await evictWarmWorker(rawInput.sessionKey, `provider switch to ${backend}`);
    }
    store.setModelSession(rawInput.sessionKey, null, backend);
    input = { ...rawInput, freshSession: true };
    log.info("model", "provider switch → cold session", {
      session: rawInput.sessionKey,
      from: transition.priorBackend,
      to: backend,
      model: profile.model,
    });
  }

  noteScreenTurn(config, rawInput.sessionKey, rawInput.cronJob ?? null);
  // The relay tools read this when the model calls them (relay/relay.ts).
  // Turns of one session run under its lock, so this is the running turn's.
  store.setTurnDepth(rawInput.sessionKey, rawInput.inboundDepth ?? 0);
  const startedAtMs = Date.now();
  let result: RunResult;
  try {
    result =
      backend === "codex"
        ? await runCodex(input, config, store)
        : await runClaude(input, config, store);
  } finally {
    releaseScreen(config, rawInput.sessionKey);
  }
  result = await dropRefusedThread(
    result,
    transition.sessionId,
    store,
    rawInput.sessionKey,
    backend,
  );

  if (result.claudeSessionId !== undefined) {
    store.setModelSession(rawInput.sessionKey, result.claudeSessionId, backend);
  } else {
    store.setSessionBackend(rawInput.sessionKey, backend);
  }
  // Everything before the turn started was in front of the model.
  if (result.ok) store.markModelTurn(rawInput.sessionKey, startedAtMs);
  // A new model conversation holds only what its first envelope carried, as
  // a compacted one holds only the re-injected thread: recall's edge of
  // verbatim sight moves to its start either way (recallSightSince).
  if (result.ok && result.claudeSessionId && result.claudeSessionId !== transition.sessionId) {
    store.markCompacted(rawInput.sessionKey, startedAtMs);
  }
  return { ...result, backend };
}
