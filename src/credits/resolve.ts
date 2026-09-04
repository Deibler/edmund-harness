import { chatIdFromKey, isDmSession, isSubagentSession, normalizeHandle } from "../sessions/key.ts";
import type { BillingMode } from "./store.ts";

/**
 * Who pays for a generation — the ONLY place that question is answered.
 *
 * Pure: every lookup is injected, so the same function runs inside the MCP
 * subprocess, the detached bg-runner, the dashboard and the CLI, and none
 * of them can drift from the others (a guard taken on one path is not a
 * guard). See docs/design/generation-credits-plan.md, "Who pays for what".
 *
 *   DM (iMessage or SMS)         → that person's wallet, keyed by the
 *                                  iMessage DM form of their normalized
 *                                  handle so both channels share one balance
 *   the operator's own DM        → house, unless they have explicitly
 *                                  flipped themselves to `wallet` to test
 *   a DM whose wallet is `house` → house (the per-person override)
 *   agent:<id>                   → whatever its parent resolves to
 *   groups, mirror, orchestrators, trading, cron, anything else → house
 */

export type BillingTarget =
  | { kind: "house"; reason: HouseReason }
  | { kind: "wallet"; sessionKey: string; handle: string };

export type HouseReason =
  | "operator"
  | "override"
  | "group-or-system"
  | "agent-without-parent"
  | "agent-depth";

export type ResolveDeps = {
  /** `alerts.operator_handle` — Alex. Empty disables the exemption. */
  operatorHandle: string;
  /** The per-person override from the credit store, or null for no row. */
  modeOf: (walletSessionKey: string) => BillingMode | null;
  /** Parent session of a spawned agent, or null when unknown. */
  parentOf: (agentId: string) => string | null;
};

const SMS_DM = "sms:dm:";
const MAX_AGENT_DEPTH = 3;

/** The wallet a DM handle bills to, regardless of channel. */
export function walletSessionKeyFor(handle: string): string {
  return `imessage:dm:${normalizeHandle(handle)}`;
}

export function resolveBillingSession(sessionKey: string, deps: ResolveDeps): BillingTarget {
  return resolveAt(sessionKey, deps, 0);
}

function resolveAt(sessionKey: string, deps: ResolveDeps, depth: number): BillingTarget {
  if (sessionKey.startsWith("agent:")) {
    if (depth >= MAX_AGENT_DEPTH) return { kind: "house", reason: "agent-depth" };
    const parent = deps.parentOf(sessionKey.slice("agent:".length));
    if (!parent) return { kind: "house", reason: "agent-without-parent" };
    return resolveAt(parent, deps, depth + 1);
  }
  // isSubagentSession also consults EDMUND_AGENT in the environment; a
  // worker whose key is not agent-prefixed still must not be billed as
  // though it were a person.
  if (isSubagentSession(sessionKey)) return { kind: "house", reason: "agent-without-parent" };

  const isDm = isDmSession(sessionKey) || sessionKey.startsWith(SMS_DM);
  if (!isDm) return { kind: "house", reason: "group-or-system" };

  const handle = normalizeHandle(chatIdFromKey(sessionKey));
  if (!handle) return { kind: "house", reason: "group-or-system" };
  const walletKey = walletSessionKeyFor(handle);
  const mode = deps.modeOf(walletKey);
  const operator = deps.operatorHandle.trim();
  if (operator && normalizeHandle(operator) === handle) {
    // The operator is house by default — but an EXPLICIT wallet row (set on
    // the Credits page, or created by granting themselves credit) opts them
    // in, so they can walk the paywall and top-up flow as a user would.
    if (mode === "wallet") return { kind: "wallet", sessionKey: walletKey, handle };
    return { kind: "house", reason: "operator" };
  }
  if (mode === "house") return { kind: "house", reason: "override" };
  return { kind: "wallet", sessionKey: walletKey, handle };
}
