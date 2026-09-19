/**
 * `[kitchen]` settings, applied to the modules that need them.
 *
 * Two entry points reach this integration: the MCP tools, which are handed a
 * loaded `Config`, and the launchd scripts, which are handed nothing. Both must
 * agree about where the ledgers live and how stale a price may be, or a tap
 * settled by the minute pass and the same tap answered by a tool would read two
 * different kitchens.
 *
 * `dir` and `price_max_age_days` were declared in the schema and read by
 * nobody for long enough that setting either did exactly nothing — a config
 * surface that lies is worse than one that is missing, because it invites
 * somebody to set it and then debug why it had no effect.
 */

import { join, resolve } from "node:path";
import { loadConfig } from "../../../src/config/config.ts";
import type { Config } from "../../../src/config/config.ts";
import { kitchenConfig } from "../config.ts";
import { useKitchenDir } from "./accounts.ts";

/** integrations/kitchen/src -> the harness root, wherever the checkout lives. */
const ROOT = join(import.meta.dir, "..", "..", "..");

/** How old an imported grocery price may be before it stops being quotable. */
let maxPriceAge = 21;

/**
 * The harness data dir, where `cron.db` lives.
 *
 * The kitchen wakes a session by inserting a one-shot cron row, which is the
 * one place it has to agree with the daemon about a path. Resolved against the
 * checkout rather than the working directory, because the launchd jobs and a
 * test runner do not share one, and `./data` from the wrong directory would
 * quietly create a second, empty cron store that nothing ever polls.
 */
let dataRoot = process.env.EDMUND_DATA_DIR ?? join(ROOT, "data");

export function dataDir(): string {
  return dataRoot;
}

/** Point the wake path at another data dir. Tests use a throwaway one. */
export function useDataDir(dir: string): void {
  dataRoot = dir;
}

export function priceMaxAgeDays(): number {
  return maxPriceAge;
}

/** Apply an already-loaded config. Used by the MCP tools, which are given one. */
export function applyKitchenConfig(config: Config): void {
  if (!process.env.EDMUND_DATA_DIR) dataRoot = resolve(ROOT, config.paths.data_dir);
  const cfg = kitchenConfig(config);
  if (!cfg) return;
  useKitchenDir(cfg.dir);
  if (typeof cfg.price_max_age_days === "number" && cfg.price_max_age_days > 0) {
    maxPriceAge = cfg.price_max_age_days;
  }
}

/**
 * Load and apply the harness config. Used by the launchd scripts.
 *
 * Best-effort on purpose: these scripts must keep running from a checkout with
 * no config at all, and every setting here has a working default. A missing
 * config is not a reason to stop confirming somebody's dinner.
 */
export function loadKitchenSettings(path = "./config.toml"): void {
  try {
    applyKitchenConfig(loadConfig(path));
  } catch {
    // Defaults stand. Nothing here is required for correctness.
  }
}
