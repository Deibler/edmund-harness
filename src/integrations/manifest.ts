/**
 * Integration manifest schema.
 *
 * Every integration under `integrations/<name>/` ships a `manifest.yaml` that
 * declares — in one place, readable without opening any TypeScript — what the
 * package is, what tools it contributes, what the model should be told about
 * it, and WHO is allowed to reach it.
 *
 * The manifest is the contract. The loader (`registry.ts`) reads it, the MCP
 * server uses it to gate tool exposure, and the daemon uses it to decide
 * whether to start the integration's runtime. An integration whose directory
 * is absent, or whose manifest sets `enabled: false`, simply does not exist as
 * far as the rest of the harness is concerned — no imports, no tools, no
 * watcher, no config keys. That is what makes these packages genuinely
 * optional: leaving one out of a checkout is a supported configuration, not a
 * broken build.
 */

import { z } from "zod";

/**
 * Which session namespaces an integration may be reached from.
 *
 * These map to the `SessionKey` namespaces in `src/sessions/key.ts`:
 *   - `main`    — the primary persona's iMessage sessions (`imessage:*`)
 *   - `orch`    — named secondary orchestrators (`orch:<key>:*`)
 *   - `trading` — the trading sub-persona (`trading:*`)
 *   - `mirror`  — the smart-mirror voice channel (`mirror:*`)
 *   - `agent`   — detached sub-agents / background runners
 *
 * An empty list means "no session may reach this", which is how you disable a
 * tool surface without deleting the package. `["*"]` means every namespace.
 */
const SessionScopeSchema = z.enum(["*", "main", "orch", "trading", "mirror", "agent"]);
export type SessionScope = z.infer<typeof SessionScopeSchema>;

/**
 * Access rules. Evaluated by `resolveAccess()` in `access.ts` against the live
 * session key + inbound handle. Deny always beats allow.
 */
export const AccessSchema = z
  .object({
    /** Session namespaces allowed to see this integration's tools. */
    sessions: z.array(SessionScopeSchema).default(["*"]),
    /**
     * Handle allowlist (E.164 phone / Apple ID). Empty = no handle
     * restriction. Used for integrations that touch money or the physical
     * house, where "any allowlisted contact" is too broad. Compared with the
     * same normalization the router uses, so formatting variants match.
     */
    handles: z.array(z.string()).default([]),
    /**
     * Session namespaces explicitly denied even if `sessions` would allow
     * them. Exists so a broad `["*"]` can carve out one namespace without
     * being rewritten into an exhaustive list.
     */
    deny_sessions: z.array(SessionScopeSchema).default([]),
    /**
     * When true, the integration's tools are hidden unless the session is
     * *dedicated* to it (session namespace equals the integration's
     * `session_namespace`). This is the trading model: Robinhood tools must
     * never appear in an ordinary chat, only inside `trading:*`.
     */
    dedicated_session_only: z.boolean().default(false),
  })
  .default({});
export type Access = z.infer<typeof AccessSchema>;

/**
 * A tool group contributed by this integration. `export_name` is the exported
 * factory in the package's `tools.ts` — the loader calls it with the live
 * `ToolContext` and splices the result into the MCP tool list.
 */
const ToolGroupSchema = z.object({
  /** Exported factory name in `tools.ts`, e.g. "tradingTools". */
  export_name: z.string().min(1),
  /** Human summary for `integrations list` / docs. Not sent to the model. */
  description: z.string().default(""),
  /**
   * Tool names this group is expected to contribute. Advisory: used by the
   * CLI and docs, and cross-checked at load in dev so a renamed tool is
   * caught rather than silently vanishing from the model's surface.
   */
  provides: z.array(z.string()).default([]),
  /** Per-group access override. Falls back to the integration's access. */
  access: AccessSchema.optional(),
});
type ToolGroup = z.infer<typeof ToolGroupSchema>;

/**
 * Model-facing instructions. Kept in the manifest (not buried in a prompt
 * builder) so the guidance an integration injects is reviewable alongside the
 * tools it exposes.
 */
const InstructionsSchema = z
  .object({
    /**
     * Path, relative to the integration directory, of a markdown file whose
     * contents are injected into the system prompt when this integration is
     * active for the session. Omit for integrations that need no preamble.
     */
    system_prompt_file: z.string().optional(),
    /**
     * Short inline guidance appended to the envelope for sessions that can
     * reach this integration. Prefer `system_prompt_file` for anything long.
     */
    envelope_note: z.string().optional(),
    /**
     * Skill directories (under `skills/`) that belong to this integration.
     * Listed so removing the package makes its skills' ownership obvious.
     */
    skills: z.array(z.string()).default([]),
  })
  .default({});
type Instructions = z.infer<typeof InstructionsSchema>;

/**
 * Runtime surface: the long-lived work an integration performs inside the
 * daemon (watchers, bridges, refreshers). The loader imports the package's
 * `index.ts` and calls `export_name` with the integration context; the
 * returned handle is stopped on shutdown.
 */
const RuntimeSchema = z
  .object({
    /**
     * Exported factory in `index.ts` that starts the integration's daemon-side
     * work and returns `{ stop() }`. Omit for tool-only integrations.
     */
    export_name: z.string().optional(),
    /**
     * Start the runtime lazily on first use instead of at boot. Used by heavy
     * integrations whose dependencies (Chrome, an Electron app, a WebSocket to
     * hardware) should not be paid for on a daemon that never touches them.
     */
    lazy: z.boolean().default(false),
  })
  .default({});
type Runtime = z.infer<typeof RuntimeSchema>;

const ManifestSchema = z.object({
  /** Package id. Must equal the directory name under `integrations/`. */
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case"),
  /** Display name for logs, CLI, and the dashboard. */
  display_name: z.string().default(""),
  version: z.string().default("0.0.0"),
  /** One line: what this integration adds to the harness. */
  description: z.string().default(""),
  /**
   * Master switch. `false` means the loader skips the package entirely — no
   * import, no tools, no runtime. The top-level `integrations-config.yaml` can
   * override this per deployment.
   */
  enabled: z.boolean().default(true),
  /**
   * Dedicated session namespace, when the integration owns one (trading owns
   * `trading:`, mirror owns `mirror:`). Enables `dedicated_session_only`
   * access and tells the router this namespace is claimed.
   */
  session_namespace: z.string().optional(),
  /**
   * Config key in `config.toml` this integration reads (e.g. "trading"). The
   * loader passes the resolved sub-config to the package. Declared here so
   * "which config section belongs to which package" is answerable without
   * grepping the schema.
   */
  config_key: z.string().optional(),
  /**
   * Other integrations that must be present and enabled. Load fails loudly
   * with the missing name rather than surfacing as a confusing import error.
   */
  requires: z.array(z.string()).default([]),
  /**
   * External binaries/services this integration needs (e.g. "cloudflared",
   * "RadarOmega.app"). Not enforced at load — surfaced by
   * `edmund integrations doctor` so a missing dependency is a clear report
   * instead of a runtime failure deep in a tool call.
   */
  external_deps: z.array(z.string()).default([]),
  access: AccessSchema,
  tools: z.array(ToolGroupSchema).default([]),
  instructions: InstructionsSchema,
  runtime: RuntimeSchema,
});

export type Manifest = z.infer<typeof ManifestSchema>;

/** Parse + validate a manifest object, tagging errors with the source path. */
export function parseManifest(raw: unknown, sourcePath: string): Manifest {
  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid integration manifest at ${sourcePath}:\n${detail}`);
  }
  return result.data;
}
