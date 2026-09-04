/**
 * The trust policy, read from [security] in config.toml.
 *
 * Every question of the form "may this session do X" that is not about a
 * guest should come through here, so that the answer lives in one place and
 * the config section is the whole story. Guest tiers keep their own module
 * (src/guests/access.ts); this file covers the operator/contact split and
 * host access.
 */

import type { Config } from "../config/config.ts";
import { normalizeHandle } from "../sessions/key.ts";

export type HostAccess = Config["security"]["model_host_access"];

/** The tiers a session can run at, from most to least trusted. */
export type SessionTier = "operator" | "contact" | "keyed-guest" | "vouched";

export function hostAccess(config: Config): HostAccess {
  // Partial configs (tests, older callers) fail closed.
  return config.security?.model_host_access ?? "sandboxed";
}

/** Operator handles, normalised. Falls back to [alerts].operator_handle. */
export function operatorHandles(config: Config): string[] {
  const explicit = config.security.operator_handles.map((h) => normalizeHandle(h)).filter(Boolean);
  if (explicit.length > 0) return explicit;
  const fallback = config.alerts.operator_handle
    ? normalizeHandle(config.alerts.operator_handle)
    : "";
  return fallback ? [fallback] : [];
}

export function isOperatorHandle(config: Config, handle: string | null | undefined): boolean {
  if (!handle) return false;
  const norm = normalizeHandle(handle);
  return operatorHandles(config).some((h) => h === norm);
}

/**
 * The tier an allowlisted (non-guest) DM sender runs at. A configured
 * operator handle is always the operator; everyone else is whatever
 * contact_tier says.
 */
function tierForAllowlisted(
  config: Config,
  handle: string | null | undefined,
): "operator" | "contact" {
  if (isOperatorHandle(config, handle)) return "operator";
  return config.security?.contact_tier ?? "contact";
}

/**
 * Groups have no single sender inside tool processes, so under the
 * "contact" policy they are always the contact tier.
 */
function tierForGroup(config: Config): "operator" | "contact" {
  return config.security?.contact_tier ?? "contact";
}

export function isGuestTier(
  tier: SessionTier | null | undefined,
): tier is "keyed-guest" | "vouched" {
  return tier === "keyed-guest" || tier === "vouched";
}

/** Parse the EDMUND_SESSION_TIER value a tool process receives. */
export function parseSessionTier(raw: string | undefined): SessionTier {
  switch (raw) {
    case "operator":
    case "contact":
    case "keyed-guest":
    case "vouched":
      return raw;
    default:
      // Absent means an older caller that predates tiers for allowlisted
      // sessions. Fail closed to the contact tier rather than open.
      return "contact";
  }
}

/**
 * The tier for a session, derived from its key. This is the ONE place the
 * decision is made; toolEnv() calls it for every worker the daemon spawns,
 * so cron fires, proactive turns, recovery turns and live turns all agree.
 *
 * DMs (iMessage, SMS, or through a named orchestrator) are judged by the
 * handle. Groups follow contact_tier. The operator's own surfaces (mirror,
 * trading, sub-agents, anything else) are the operator.
 */
export function tierForSessionKey(
  config: Config,
  sessionKey: string,
  guestTier: "keyed-guest" | "vouched" | null = null,
): SessionTier {
  if (guestTier) return guestTier;
  const dm = sessionKey.match(/^(?:imessage:dm:|sms:dm:|orch:[^:]+:dm:)(.+)$/);
  if (dm) return tierForAllowlisted(config, dm[1]);
  if (/^(?:imessage:group:|sms:group:|orch:[^:]+:group:)/.test(sessionKey))
    return tierForGroup(config);
  return "operator";
}

/**
 * Claude Code built-in tools a worker may not use. `Task` is always out (the
 * harness has its own agent system). Under sandboxed host access, or for any
 * guest, every filesystem and shell built-in goes too: Read is unrestricted
 * by the PreToolUse guard, which only covers writes, so an injected prompt
 * could otherwise read anything on the Mac.
 */
export function disallowedBuiltinTools(access: HostAccess, guest: boolean): string {
  return access === "sandboxed" || guest
    ? "Task Bash Read Write Edit NotebookEdit Glob Grep"
    : "Task";
}

/**
 * Environment variable names (or prefixes, ending in `_`) a sandboxed worker
 * may inherit from the daemon. Everything else in the daemon's environment
 * (Twilio credentials, whatever the shell exported) stays behind.
 */
const SANDBOXED_ENV_ALLOW = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TMPDIR",
  "TERM",
  "TZ",
  "LANG",
  "PWD",
  "LC_",
  "XDG_",
  "CLAUDE_",
  "ANTHROPIC_",
  "CODEX_",
  "OPENAI_",
  "EDMUND_",
  "BUN_",
  "NODE_",
  "SSL_CERT_",
  "NO_COLOR",
  "FORCE_COLOR",
  "HOMEBREW_",
];

export function envAllowedWhenSandboxed(name: string): boolean {
  return SANDBOXED_ENV_ALLOW.some((a) => (a.endsWith("_") ? name.startsWith(a) : name === a));
}
