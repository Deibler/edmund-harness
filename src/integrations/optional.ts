/**
 * Optional integration access for core code.
 *
 * A handful of core paths genuinely need something an integration provides:
 * the envelope builder must ask the mirror for its glass inventory. Importing
 * those directly would make the integration mandatory: delete the directory
 * and core stops compiling.
 *
 * These helpers resolve through the registry using COMPUTED paths, so the
 * TypeScript compiler never treats an integration as a build dependency, and a
 * missing package degrades to the documented fallback instead of a crash.
 *
 * The helper answers the "integration absent" case explicitly: with no mirror
 * package there is no mirror envelope block and there are no glass mutations,
 * which is correct for a harness that does not have that capability installed.
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
