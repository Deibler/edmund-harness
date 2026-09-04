import type { Config } from "../config/config.ts";
import * as intSettings from "../integrations/settings.ts";
import type { SessionKey } from "../sessions/key.ts";
import { isTradingSession } from "../sessions/key.ts";

export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelProfile = { model: string; effort: ModelEffort };

/** Resolve the effective model after session-specific overrides. */
export function modelProfileForSession(
  sessionKey: SessionKey,
  config: Config,
  orchestratorModel: string | null = null,
): ModelProfile {
  if (isTradingSession(sessionKey) && intSettings.trading(config).model) {
    return {
      model: intSettings.trading(config).model,
      effort: intSettings.trading(config).effort || config.claude.effort,
    };
  }
  if (sessionKey === intSettings.mirror(config).session_key) {
    return {
      model: intSettings.mirror(config).model,
      effort: intSettings.mirror(config).effort || config.claude.effort,
    };
  }
  return {
    model: orchestratorModel ?? config.claude.model,
    effort: config.claude.effort,
  };
}
