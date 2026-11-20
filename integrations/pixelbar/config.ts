/**
 * `[pixelbar]` configuration for the Pixel Bar integration.
 *
 * The schema lives with the package; core keeps the raw table opaque. The key
 * is the bar's pairing key (shown on its info screen): it belongs in the
 * gitignored config.toml only, never in config.example.toml.
 */

import { z } from "zod";
import { defineSection } from "../../src/integrations/section.ts";

export const Schema = z
  .object({
    /** Master switch. False = no tools. */
    enabled: z.boolean().default(false),
    /** Where the bar answers on the LAN. */
    url: z.string().default("http://pixelbar.local"),
    /** The bar's pairing key: hold its left key and read the small screen. */
    key: z.string().default(""),
    /** How long to wait for the bar. It answers in tens of milliseconds when it is awake. */
    timeout_ms: z.number().int().positive().default(4000),
  })
  .default({});

export type PixelbarConfig = z.infer<typeof Schema>;

export const pixelbarConfig = defineSection("pixelbar", Schema);

/** True when the section names a bar the integration can talk to. */
export function isConfigured(cfg: PixelbarConfig): boolean {
  return cfg.enabled && !!cfg.url && !!cfg.key;
}
