/**
 * How a conversation's worker runs while it is on a call.
 *
 * A reply is spoken as it is written, so whatever keeps the model from
 * writing is silence on the line. The first live calls (2026-10-29) measured
 * both causes: at the DM's `xhigh` effort replies took 1.7-7.2 s of thinking
 * before the first word, and asked whether hanging up would cut its last line,
 * Edmund ran shell commands for 40 s and said nothing until he hung up. So on
 * a call he thinks less per reply, and the tools that block for seconds are
 * off: that work goes to background agents (spawn_agent) while he keeps
 * talking, which is what the envelope tells him and now the only way it can go.
 *
 * Effort and the disallowed tools are spawn-time arguments and both are in the
 * worker's rebind key, so the session's worker is respawned once as the call
 * starts ringing and once after it ends. The model and the transcript are the
 * same, so the conversation and its prompt cache carry across.
 */

import type { Config } from "../config/config.ts";
import type { ModelEffort } from "../model/profile.ts";
import type { SessionKey } from "../sessions/key.ts";
import { isVoiceLive } from "./binding.ts";

/** Built-in tools that can block a turn for seconds at a time. */
export const CALL_BLOCKED_TOOLS = ["Bash", "WebFetch", "WebSearch"] as const;

export type CallLoadout = { effort: ModelEffort; blockedTools: readonly string[] };

/** The call loadout for a session with a live (or ringing) call, else null. */
export function callLoadout(sessionKey: SessionKey, config: Config): CallLoadout | null {
  if (!isVoiceLive(sessionKey)) return null;
  return { effort: config.facetime?.effort ?? "low", blockedTools: CALL_BLOCKED_TOOLS };
}

/** A worker's `--disallowedTools` list with the call's blocks added while it is on a call. */
export function withCallBlocks(disallowed: string, sessionKey: SessionKey, config: Config): string {
  const blocked = callLoadout(sessionKey, config)?.blockedTools ?? [];
  return [...new Set([...disallowed.split(" ").filter(Boolean), ...blocked])].join(" ");
}
