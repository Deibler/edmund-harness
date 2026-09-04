/**
 * `[fishing]` configuration for the fishing integration.
 *
 * The schema lives HERE, with the package, rather than in core's
 * `src/config/config.ts`. Core keeps the raw `[fishing]` table from config.toml
 * as an opaque value and never validates or types it — that is what lets this
 * integration be deleted without touching the core schema.
 *
 * Call `fishingConfig(config)` to get a validated, typed view. Results are memoized
 * per Config object, so repeated calls on a hot path cost one WeakMap lookup.
 */

import { z } from "zod";
import { defineSection } from "../../src/integrations/section.ts";

export const Schema = z
  .object({
    /** Master switch. False = no tools at all. */
    enabled: z.boolean().default(false),
    /** Base URL of the local fishing API (no trailing slash needed). */
    api_url: z.string().default("http://127.0.0.1:8087/api/v1"),
  })
  .default({});

export type FishingConfig = z.infer<typeof Schema>;

/**
 * Validated `[fishing]` settings, memoized per Config object. A missing or
 * malformed table degrades to schema defaults (and logs) instead of
 * preventing the daemon from booting.
 */
export const fishingConfig = defineSection("fishing", Schema);
