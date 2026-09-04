/**
 * `[kitchen]` configuration.
 *
 * The schema lives with the package rather than in core's config, which is what
 * lets this whole directory be deleted without touching core source.
 */

import { resolve } from "node:path";
import { z } from "zod";
import { defineSection } from "../../src/integrations/section.ts";

export const Schema = z
  .object({
    /** Master switch. False = no tools at all. */
    enabled: z.boolean().default(true),
    /**
     * Where the ledgers live. Deliberately outside any session sandbox: one
     * physical kitchen is shared across chats, so a per-chat copy would be
     * fiction in every thread at once.
     */
    dir: z.string().default(resolve(process.env.EDMUND_DATA_DIR ?? "./data", "kitchen")),
    /** How old an imported grocery price may be before it stops being quotable. */
    price_max_age_days: z.number().default(21),
  })
  .default({});

export type KitchenConfig = z.infer<typeof Schema>;

export const kitchenConfig = defineSection("kitchen", Schema);
