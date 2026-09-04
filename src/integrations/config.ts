/**
 * Top-level integrations config (`integrations/integrations-config.yaml`).
 *
 * The per-package `manifest.yaml` is the *package's* declaration: what it is,
 * what it provides, and the access rules its author considers correct. This
 * file is the *operator's* view: which of the installed packages this machine
 * actually runs, and any per-deployment tightening.
 *
 * Split this way because the two change for different reasons. A manifest
 * changes when the integration's capabilities change (and ships with the
 * package). This file changes when you turn something on or off on one box —
 * without editing a tracked package file, and without a code change.
 *
 * Everything here is optional. A missing file means "use every manifest as
 * written", which is the right default for a fresh checkout.
 */

import { z } from "zod";
import { AccessSchema } from "./manifest.ts";

/** Per-integration deployment override. */
const IntegrationOverrideSchema = z.object({
  /** Force on/off regardless of the manifest's own `enabled`. */
  enabled: z.boolean().optional(),
  /**
   * Narrow (or widen) who may reach this integration on this machine. Merged
   * over the manifest's access block, so you can restrict `handles` without
   * restating the session rules.
   */
  access: AccessSchema.optional(),
  /** Free-form operator note; surfaced by `edmund integrations list`. */
  note: z.string().optional(),
});
type IntegrationOverride = z.infer<typeof IntegrationOverrideSchema>;

export const TopLevelConfigSchema = z.object({
  /**
   * Applied to every integration before its own override. Chiefly useful as
   * `enabled: false` — an opt-in posture where nothing runs until it is named
   * in the `integrations:` map below.
   */
  defaults: z
    .object({
      enabled: z.boolean().optional(),
    })
    .default({}),
  /** Keyed by integration name (the directory under `integrations/`). */
  integrations: z.record(z.string(), IntegrationOverrideSchema).default({}),
});

export type IntegrationsConfig = z.infer<typeof TopLevelConfigSchema>;
