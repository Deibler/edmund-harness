/**
 * `[radaromega]` configuration for the radaromega integration.
 *
 * The schema lives HERE, with the package, rather than in core's
 * `src/config/config.ts`. Core keeps the raw `[radaromega]` table from config.toml
 * as an opaque value and never validates or types it — that is what lets this
 * integration be deleted without touching the core schema.
 *
 * Call `radaromegaConfig(config)` to get a validated, typed view. Results are memoized
 * per Config object, so repeated calls on a hot path cost one WeakMap lookup.
 */

import { z } from "zod";
import { defineSection } from "../../src/integrations/section.ts";

export const Schema = z
  .object({
    /** Master switch for the whole RadarOmega integration: the MCP server
     *  in the worker loadout, the system-prompt weather routing, the
     *  radaromega* skills, app-probe (app_js) triggers, and the CLI
     *  app autolaunch. Flip to false if the subscription lapses — the
     *  harness degrades cleanly to web-based weather. */
    enabled: z.boolean().default(true),
    /** Unpacked radaromega-mcp package path. Relative paths resolve from repo root. */
    package_path: z.string().default("./vendor/radaromega-mcp"),
    /** Chrome DevTools Protocol port used by RadarOmega. Must match the app launch flag. */
    cdp_port: z.number().int().positive().default(9222),
    /** Preventative freshness restart: the app's model engine wedges after
     *  long uptime (callbacks stop firing), so the daemon relaunches the
     *  app once it has been up this many hours — only while no worker is
     *  mid-turn, so it never yanks the app out from under a session.
     *  0 disables the watchdog (the MCP tools still self-heal on use). */
    refresh_hours: z.number().min(0).default(6),
  })
  .default({});

export type RadarOmegaConfig = z.infer<typeof Schema>;

/**
 * Validated `[radaromega]` settings, memoized per Config object. A missing or
 * malformed table degrades to schema defaults (and logs) instead of
 * preventing the daemon from booting.
 */
export const radaromegaConfig = defineSection("radaromega", Schema);
