export type ModelBackend = "claude" | "codex";

/**
 * Pick the local agent CLI from the configured model name.
 *
 * Unknown names deliberately stay on Claude for backward compatibility:
 * deployments may use Anthropic aliases or provider-specific model names
 * that do not start with `claude-`. OpenAI's GPT/o-series and Codex aliases
 * are distinctive enough to route without another config knob.
 */
export function backendForModel(model: string): ModelBackend {
  const name = model.trim().toLowerCase();
  return /^(?:gpt(?:-|$)|chatgpt(?:-|$)|o[1-9](?:-|$)|codex(?:-|$))/.test(name)
    ? "codex"
    : "claude";
}

export type StoredModelSession = {
  sessionId: string | null;
  backend: ModelBackend | null;
};

/**
 * Decide whether an opaque provider thread may be resumed. Legacy rows with
 * an id and no backend are Claude rows; all cross-provider transitions drop
 * the id so neither CLI can parse the other's transcript format.
 */
export function transitionModelSession(
  stored: StoredModelSession,
  nextBackend: ModelBackend,
): { sessionId: string | null; priorBackend: ModelBackend | null; switched: boolean } {
  const priorBackend = stored.backend ?? (stored.sessionId ? "claude" : null);
  const switched = priorBackend !== null && priorBackend !== nextBackend;
  return {
    sessionId: switched ? null : stored.sessionId,
    priorBackend,
    switched,
  };
}
