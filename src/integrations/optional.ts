/**
 * Optional integration access for core code.
 *
 * A handful of core paths genuinely need something an integration provides —
 * the router must ask whether an inbound belongs to the trading persona, the
 * envelope builder must ask the mirror for its glass inventory. Importing
 * those directly would make the integration mandatory: delete the directory
 * and core stops compiling.
 *
 * These helpers resolve through the registry using COMPUTED paths, so the
 * TypeScript compiler never treats an integration as a build dependency, and a
 * missing package degrades to the documented fallback instead of a crash.
 *
 * Each helper answers the "integration absent" case explicitly:
 *   - no trading package  → nothing routes to the trading persona
 *   - no mirror package   → no mirror envelope block, no glass mutations
 *
 * Both are correct behavior for a harness that simply doesn't have that
 * capability installed.
 */

import { log } from "../util/log.ts";
import { getRegistry } from "./registry.ts";

/**
 * Cache of resolved exports. `undefined` = not looked up yet; `null` = looked
 * up and unavailable (integration absent/disabled), which is cached so a
 * missing package costs one lookup rather than one per turn.
 */
const cache = new Map<string, unknown | null>();

/**
 * Resolve a named export from an integration, or null when the integration is
 * not installed/enabled. Async because the underlying import is.
 */
export async function integrationExport<T>(
  integration: string,
  file: string,
  exportName: string,
): Promise<T | null> {
  const key = `${integration}:${file}:${exportName}`;
  if (cache.has(key)) return cache.get(key) as T | null;

  const mod = await getRegistry().importModule(integration, file);
  const value = (mod?.[exportName] ?? null) as T | null;
  if (mod && value === null) {
    log.warn("integrations", "expected export missing", { integration, file, exportName });
  }
  cache.set(key, value);
  return value;
}

/**
 * Synchronous variant backed by a warm-up pass. Core paths that cannot await
 * (the watcher's synchronous `onMessage`) call `warmOptionalExports()` once at
 * boot, then read the cached value here.
 *
 * Returns null before warm-up completes, which is the same as "not installed"
 * — safe, because the fallback behavior is always the no-integration path.
 */
export function integrationExportSync<T>(
  integration: string,
  file: string,
  exportName: string,
): T | null {
  return (cache.get(`${integration}:${file}:${exportName}`) ?? null) as T | null;
}

/**
 * Pre-resolve the exports core reads synchronously. Called once during boot,
 * before the watcher starts, so `integrationExportSync` is populated by the
 * time the first message arrives.
 */
export async function warmOptionalExports(): Promise<void> {
  await Promise.all([
    // Router gate: decides whether an inbound belongs to the trading persona.
    integrationExport("trading", "index.ts", "tradingGate"),
  ]);
}
