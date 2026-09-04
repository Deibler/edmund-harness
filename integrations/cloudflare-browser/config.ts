/**
 * `[cloudflare]` configuration for the cloudflare-browser integration.
 *
 * The schema lives HERE, with the package, rather than in core's
 * `src/config/config.ts`. Core keeps the raw `[cloudflare]` table from config.toml
 * as an opaque value and never validates or types it — that is what lets this
 * integration be deleted without touching the core schema.
 *
 * Call `cloudflareConfig(config)` to get a validated, typed view. Results are memoized
 * per Config object, so repeated calls on a hot path cost one WeakMap lookup.
 */

import { z } from "zod";
import { defineSection } from "../../src/integrations/section.ts";

export const Schema = z
  .object({
    account_id: z.string().default(""),
    api_token: z.string().default(""),
  })
  .default({ account_id: "", api_token: "" });

export type CloudflareConfig = z.infer<typeof Schema>;

/**
 * Validated `[cloudflare]` settings, memoized per Config object. A missing or
 * malformed table degrades to schema defaults (and logs) instead of
 * preventing the daemon from booting.
 */
export const cloudflareConfig = defineSection("cloudflare", Schema);
