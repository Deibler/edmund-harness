import { shouldCompact } from "../claude/auto-compact.ts";
import { type RunInput, type RunResult, evictWarmWorker, runClaude } from "../claude/runner.ts";
import { runCodex } from "../codex/runner.ts";
import type { Config } from "../config/config.ts";
import { orchestratorForSession } from "../orchestrators/registry.ts";
import type { StateStore } from "../sessions/store.ts";
import { log } from "../util/log.ts";
import { type ModelBackend, backendForModel, transitionModelSession } from "./backend.ts";
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
 * Shared turn entry point. Model selection remains where it always was in
 * config; only the effective model name decides which installed CLI runs it.
 */
export async function runModel(
  rawInput: RunInput,
  config: Config,
  store: StateStore,
): Promise<ModelRunResult> {
  const orchestrator = orchestratorForSession(rawInput.sessionKey, config);
  const override =
    orchestrator && !orchestrator.builtin && orchestrator.model ? orchestrator.model : null;
  const profile = modelProfileForSession(rawInput.sessionKey, config, override);
  const backend = backendForModel(profile.model);
  const existing = store.getSession(rawInput.sessionKey);
  const transition = transitionModelSession(
    {
      sessionId: existing?.claudeSessionId ?? null,
      backend: existing?.sessionBackend ?? null,
    },
    backend,
  );

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

  const result =
    backend === "codex"
      ? await runCodex(input, config, store)
      : await runClaude(input, config, store);

  if (result.claudeSessionId !== undefined) {
    store.setModelSession(rawInput.sessionKey, result.claudeSessionId, backend);
  } else {
    store.setSessionBackend(rawInput.sessionKey, backend);
  }
  return { ...result, backend };
}
