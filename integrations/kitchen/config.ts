/**
 * `[kitchen]` configuration schema.
 *
 * Owned by the package rather than core config, so the integration can be
 * removed without touching core source.
 */

import { resolve } from "node:path";
import { z } from "zod";
import { defineSection } from "../../src/integrations/section.ts";

export const Schema = z
  .object({
    /** Master switch. False registers no tools. */
    enabled: z.boolean().default(true),
    /**
     * Where the ledgers live. Outside any session sandbox, because one kitchen
     * is shared by every chat that belongs to the household.
     */
    dir: z.string().default(resolve(process.env.EDMUND_DATA_DIR ?? "./data", "kitchen")),
    /** How old an imported grocery price may be before it stops being quotable. */
    price_max_age_days: z.number().default(21),
    /**
     * Public origin the kitchen host serves every household's site from, e.g.
     * "https://kitchen.example.com", through a named tunnel that survives
     * restarts (src/host.ts). Unset: sites are rendered but not published.
     */
    site_origin: z.string().url().nullish(),
    /** Local port of the host's router, which that tunnel points at. */
    host_port: z.number().int().default(4795),
  })
  .default({});

export type KitchenConfig = z.infer<typeof Schema>;

export const kitchenConfig = defineSection("kitchen", Schema);
