/**
 * Server-side config accessor. Thin wrapper around loadConfig so routes see a
 * consistent surface and can refetch cheaply after writes.
 */

import { loadConfig } from "../../src/config/config.ts";
import type { Config } from "../../src/config/config.ts";

let cached: { value: Config; at: number } | null = null;

export function getConfig(forceReload = false): Config {
  if (!forceReload && cached && Date.now() - cached.at < 1000) {
    return cached.value;
  }
  const value = loadConfig();
  cached = { value, at: Date.now() };
  return value;
}

export function invalidateConfig(): void {
  cached = null;
}
