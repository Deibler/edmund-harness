/**
 * Integration access control.
 *
 * Answers one question: may THIS session reach THIS integration? Every tool
 * exposure and runtime start goes through here, so the rule lives in exactly
 * one place instead of being re-implemented as an ad-hoc `if` at each call
 * site (which is how `trading` tools nearly leaked into ordinary chats before
 * they self-gated).
 *
 * Evaluation order — first match wins, deny beats allow:
 *   1. dedicated_session_only  → session namespace must equal the
 *                                integration's own `session_namespace`
 *   2. deny_sessions           → explicit denial
 *   3. sessions                → allowlist ("*" = any namespace)
 *   4. handles                 → handle allowlist, when non-empty
 */

import { isMirrorSession, isTradingSession, normalizeHandle } from "../sessions/key.ts";
import type { SessionKey } from "../sessions/key.ts";
import type { Access, Manifest, SessionScope } from "./manifest.ts";

/** Why access was refused. Surfaced in logs + `integrations doctor`. */
export type DenyReason =
  | "disabled"
  | "not-dedicated-session"
  | "session-denied"
  | "session-not-allowed"
  | "handle-not-allowed";

export type AccessDecision = { allowed: true } | { allowed: false; reason: DenyReason };

const ALLOWED: AccessDecision = { allowed: true };

/**
 * Classify a session key into its namespace scope. Mirrors the routing rules
 * in `src/sessions/key.ts` — `orch:` and `trading:`/`mirror:` are explicit
 * prefixes, an agent context is flagged by the caller, and everything else is
 * the main persona.
 */
function scopeForSession(sessionKey: SessionKey | null, isAgent = false): SessionScope {
  if (isAgent) return "agent";
  if (!sessionKey) return "main";
  if (isTradingSession(sessionKey)) return "trading";
  if (isMirrorSession(sessionKey)) return "mirror";
  if (sessionKey.startsWith("orch:")) return "orch";
  return "main";
}

/** True when the scope list permits `scope` (`"*"` matches everything). */
function scopeMatches(list: SessionScope[], scope: SessionScope): boolean {
  return list.includes("*") || list.includes(scope);
}

export type AccessInput = {
  sessionKey: SessionKey | null;
  /** Inbound sender handle, when one exists (absent for cron/agent turns). */
  handle?: string | null;
  /** True when evaluating inside a detached sub-agent / background runner. */
  isAgent?: boolean;
};

/**
 * Resolve access for one integration. `access` defaults to the manifest's own
 * rules; pass a tool group's override to evaluate that group instead.
 */
export function resolveAccess(
  manifest: Manifest,
  input: AccessInput,
  access: Access = manifest.access,
): AccessDecision {
  if (!manifest.enabled) return { allowed: false, reason: "disabled" };

  const scope = scopeForSession(input.sessionKey, input.isAgent);

  // 1. Dedicated-session integrations (trading, mirror) are invisible from
  //    anywhere but their own namespace. This is the strongest rule and it
  //    runs first so a permissive `sessions: ["*"]` can never widen it.
  if (access.dedicated_session_only) {
    const ns = manifest.session_namespace;
    if (!ns) {
      // Manifest bug: dedicated gating with nothing to gate on. Fail closed —
      // a misconfigured guard must not silently become "allow everyone".
      return { allowed: false, reason: "not-dedicated-session" };
    }
    const key = input.sessionKey ?? "";
    if (!key.startsWith(`${ns}:`)) {
      return { allowed: false, reason: "not-dedicated-session" };
    }
  }

  // 2. Explicit denials beat the allowlist.
  if (scopeMatches(access.deny_sessions, scope)) {
    return { allowed: false, reason: "session-denied" };
  }

  // 3. Namespace allowlist.
  if (!scopeMatches(access.sessions, scope)) {
    return { allowed: false, reason: "session-not-allowed" };
  }

  // 4. Handle allowlist, when the integration declares one. A turn with no
  //    handle (cron, recovery, agent) cannot satisfy a handle restriction, so
  //    handle-gated integrations are correctly invisible to automated turns.
  if (access.handles.length > 0) {
    const handle = input.handle ? normalizeHandle(input.handle) : "";
    if (!handle) return { allowed: false, reason: "handle-not-allowed" };
    const permitted = access.handles.map(normalizeHandle);
    if (!permitted.includes(handle)) {
      return { allowed: false, reason: "handle-not-allowed" };
    }
  }

  return ALLOWED;
}

/** Human-readable explanation for logs and the CLI. */
export function explainDenial(name: string, reason: DenyReason): string {
  switch (reason) {
    case "disabled":
      return `${name}: disabled in its manifest or integrations-config.yaml`;
    case "not-dedicated-session":
      return `${name}: only reachable from its own dedicated session namespace`;
    case "session-denied":
      return `${name}: this session namespace is explicitly denied`;
    case "session-not-allowed":
      return `${name}: this session namespace is not in the allowlist`;
    case "handle-not-allowed":
      return `${name}: sender handle is not on the integration's allowlist`;
  }
}
