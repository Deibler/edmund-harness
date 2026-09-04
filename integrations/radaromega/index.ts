/**
 * RadarOmega integration — public surface.
 *
 * The tool surface itself is the vendored MCP server (`vendor/radaromega-mcp`),
 * which the worker loads over stdio and which drives the RadarOmega desktop app
 * through the Chrome DevTools Protocol. This package owns the *daemon-side*
 * half: a freshness watchdog that keeps the app's model engine from wedging.
 */

import type { Config } from "../../src/config/config.ts";
import type { IntegrationRuntime, IntegrationRuntimeContext } from "../../src/integrations/host.ts";
import { log } from "../../src/util/log.ts";
import { radaromegaConfig } from "./config.ts";
import { RadarOmegaRefresher } from "./src/refresher.ts";

export { RadarOmegaRefresher } from "./src/refresher.ts";

/**
 * Start the freshness watchdog. RadarOmega's model engine corrupts after long
 * uptime (engine callbacks stop firing — cost a worker a 28-minute turn on
 * 2026-06-10), so the app is relaunched preventatively once its uptime crosses
 * the configured threshold.
 *
 * The restart is deferred while any pooled Claude worker is mid-turn, so it can
 * never land in the middle of a radar session. The MCP tools' reactive
 * self-heal remains the backstop for a wedge that forms between sweeps.
 */
export function startRadarOmegaRuntime(ctx: IntegrationRuntimeContext): IntegrationRuntime | null {
  const config = ctx.config as Config;
  const settings = radaromegaConfig(config);
  if (!settings?.enabled || settings.refresh_hours <= 0) return null;

  const refresher = new RadarOmegaRefresher({
    cdpPort: settings.cdp_port,
    maxUptimeMs: settings.refresh_hours * 3_600_000,
    checkIntervalMs: 15 * 60_000,
    isBusy: ctx.isBusy,
    log: (msg) => console.log(msg),
  });
  refresher.start();
  log.info("radaromega", "freshness watchdog started", {
    relaunch_after_hours: settings.refresh_hours,
    when: "idle",
  });

  return { stop: () => refresher.stop() };
}
