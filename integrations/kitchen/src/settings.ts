/**
 * Applies `[kitchen]` settings to the modules that read them.
 *
 * The MCP tools receive a loaded `Config`; the launchd scripts load one
 * themselves. Both paths go through `applyKitchenConfig`, so a tap settled by
 * the watch pass and the same tap answered by a tool read the same kitchen.
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
 * The harness data dir, where the daemon's `cron.db` lives. Wakes are cron rows,
 * so this must match the daemon exactly. It is resolved against the checkout,
 * not the working directory: a relative `./data` from the wrong directory would
 * create a second, empty cron store that nothing polls.
 */
let dataRoot = process.env.EDMUND_DATA_DIR ?? join(ROOT, "data");

export function dataDir(): string {
  return dataRoot;
}

export function priceMaxAgeDays(): number {
  return maxPriceAge;
}

/** Apply an already-loaded config (the MCP tools' path). */
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
 * Load and apply the harness config (the launchd scripts' path). Best-effort:
 * every setting has a working default, and the scripts must keep running from
 * a checkout with no config.
 */
export function loadKitchenSettings(path = "./config.toml"): void {
  try {
    applyKitchenConfig(loadConfig(path));
  } catch {
    // Defaults stand.
  }
}
