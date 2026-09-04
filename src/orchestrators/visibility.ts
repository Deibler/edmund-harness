import type { Config } from "../config/config.ts";
import { orchestratorOfSession } from "../sessions/key.ts";
import { matchOrchestrator, primaryOrchestrator } from "./registry.ts";

/**
 * Per-orchestrator message visibility — the privacy contract of the
 * multi-orchestrator system.
 *
 * Rule: a message belongs to the orchestrator it was routed to (inbound)
 * or sent by (outbound). Primary traffic is public — every orchestrator
 * may see it (a secondary is a guest in a chat the primary mostly runs).
 * NON-primary traffic is private to its orchestrator: the primary never
 * sees messages that invoked a secondary, nor the secondary's replies.
 * Trading traffic ("wolf, …") is likewise private to the trading persona.
 *
 * Ownership resolution, in order of reliability:
 *   1. message_routing row (rowId → session key, recorded at accept time)
 *   2. sent-attribution row (outbound: chatGuid + exact text + time window)
 *   3. text fallback: re-run the invocation matcher on the message text
 *      (covers rows older than the 30-day routing-table prune)
 *   4. unowned → visible to everyone (pre-feature history, system rows)
 *
 * When no [[orchestrators]] are configured the filter is a constant true —
 * zero behavior change for single-persona deployments.
 */

/** Shape every history consumer already has (HistoryLine superset). */
export type VisibilityLine = {
  rowId?: number;
  fromMe: boolean;
  text: string;
  timestampMs?: number;
};

/** Structural subset of StateStore — what the filter needs to resolve
 *  ownership. Any object with these two methods works (the daemon passes
 *  its live StateStore; MCP tools open their own read handle). */
export type VisibilityStore = {
  getRoutedSession(rowId: number): string | null;
  attributionsFor(
    chatGuid: string,
    sinceMs: number,
  ): { orchestrator: string; text: string; atMs: number }[];
};

/** Match window for outbound attribution: a chat.db is_from_me row and the
 *  deliver-time record of the same chunk should land within seconds; the
 *  generous window absorbs clock skew and slow bridge sends. */
const ATTRIBUTION_WINDOW_MS = 10 * 60_000;

export function viewerForSession(sessionKey: string): string | null {
  if (sessionKey.startsWith("trading:")) return "trading";
  return orchestratorOfSession(sessionKey);
}

/**
 * Build a line filter for one viewer in one chat (or a set of chats — DM
 * sessions span alias-handle chat guids). Loads the chats' outbound
 * attributions once; routing lookups are per-row point queries
 * (indexed PK, microseconds each).
 */
export function makeHistoryFilter(
  viewer: string | null,
  chatGuid: string | string[],
  config: Config,
  store: VisibilityStore | null,
): (line: VisibilityLine) => boolean {
  if (config.orchestrators.length === 0) return () => true;

  const primaryKey = primaryOrchestrator(config).key;
  const guids = Array.isArray(chatGuid) ? chatGuid : [chatGuid];
  const sinceMs = Date.now() - 90 * 24 * 3_600_000;
  const attributions = store ? guids.flatMap((g) => store.attributionsFor(g, sinceMs)) : [];

  const ownerOf = (line: VisibilityLine): string | null => {
    if (line.fromMe) {
      if (line.timestampMs === undefined) return null;
      const norm = normText(line.text);
      for (const a of attributions) {
        if (
          Math.abs(a.atMs - line.timestampMs) <= ATTRIBUTION_WINDOW_MS &&
          normText(a.text) === norm
        ) {
          return a.orchestrator;
        }
      }
      return null;
    }
    if (line.rowId !== undefined && store) {
      const routedKey = store.getRoutedSession(line.rowId);
      if (routedKey) {
        if (routedKey.startsWith("trading:")) return "trading";
        const o = orchestratorOfSession(routedKey);
        if (o) return o;
      }
    }
    // No routing record (pruned or pre-feature): re-derive from the text.
    const matched = matchOrchestrator(line.text, config);
    return matched ? matched.key : null;
  };

  return (line) => {
    const owner = ownerOf(line);
    if (owner === null) return true;
    if (owner === viewer) return true;
    if (owner === primaryKey) return true;
    return false;
  };
}

/**
 * Text-only visibility check for surfaces that carry no rowId/attribution
 * (semantic-recall snippets). Conservative: a line that names a non-primary
 * orchestrator is hidden from everyone but that orchestrator, even if it
 * was actually primary traffic mentioning the name in passing — recall is
 * enrichment, and dropping a line is always privacy-safe.
 */
export function textVisibleTo(text: string, viewer: string | null, config: Config): boolean {
  if (config.orchestrators.length === 0) return true;
  const owner = matchOrchestrator(text, config)?.key ?? null;
  if (owner === null || owner === viewer) return true;
  return owner === primaryOrchestrator(config).key;
}

function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
