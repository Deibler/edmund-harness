import type { Config } from "../config/config.ts";
import * as intSettings from "../integrations/settings.ts";
import type { SessionKey } from "../sessions/key.ts";
import { callLoadout } from "./call-loadout.ts";

export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelProfile = { model: string; effort: ModelEffort };

/** Resolve the effective model after session-specific overrides. A session on
 *  a live call takes the call's model and effort (model/call-loadout.ts). */
export function modelProfileForSession(sessionKey: SessionKey, config: Config): ModelProfile {
  const profile = baseProfile(sessionKey, config);
  const call = callLoadout(sessionKey, config);
  return call ? { model: call.model ?? profile.model, effort: call.effort } : profile;
}

function baseProfile(sessionKey: SessionKey, config: Config): ModelProfile {
  // No Grok branch: connector requests run inside the person's DM session and
  // use its model (src/grok/session.ts). A model is chosen per session, not per
  // turn, so an override would also move their texts.
  if (sessionKey === intSettings.mirror(config).session_key) {
    return {
      model: intSettings.mirror(config).model,
      effort: intSettings.mirror(config).effort || config.claude.effort,
    };
  }
  return {
    model: config.claude.model,
    effort: config.claude.effort,
  };
}
