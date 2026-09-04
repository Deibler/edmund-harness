/**
 * Host API — the seam between the harness and its integrations.
 *
 * Two consumers:
 *   - `src/mcp/server.ts` calls `collectIntegrationTools()` to splice plugin
 *     tools into the MCP tool list, already access-filtered.
 *   - `src/main.ts` calls `startIntegrationRuntimes()` to boot watchers,
 *     bridges, and refreshers, and stops them on shutdown.
 *
 * Both go through the registry, so neither file names a specific integration.
 * Adding an integration is: create the directory, write a manifest. Removing
 * one is: delete the directory. No core edits either way — that is the whole
 * point of the indirection.
 */

import { readFileSync } from "node:fs";
import type { Config } from "../config/config.ts";
import type { SessionKey } from "../sessions/key.ts";
import { log } from "../util/log.ts";
import { type AccessInput, explainDenial, resolveAccess } from "./access.ts";
import type { LoadedIntegration } from "./registry.ts";
import { getRegistry } from "./registry.ts";

/** Files an integration package is expected to expose, by convention. */
const TOOLS_FILE = "tools.ts";
const INDEX_FILE = "index.ts";

/**
 * Context handed to an integration's runtime factory. Deliberately narrow: an
 * integration gets the harness config and a few capabilities, not the whole
 * `Deps` bag, so the blast radius of a misbehaving package stays small.
 */
/**
 * Extra capabilities granted only to *channel* integrations — those that are a
 * medium the assistant talks through (the smart mirror), not merely a tool
 * surface. A channel needs to push turns into the pipeline, interrupt an
 * in-flight turn, observe the model's lifecycle, and register itself as a
 * delivery target for replies addressed to its sessions.
 *
 * Kept separate from the base context so an ordinary tool integration is
 * structurally incapable of reaching into the turn pipeline: it simply is not
 * handed these functions.
 */
type ChannelCapabilities = {
  /** Enqueue an inbound message; same debounce/lock path iMessage uses. */
  pipeline: unknown;
  /** Abort the in-flight model turn for a session. Returns false if none. */
  interruptTurn: (sessionKey: SessionKey, reason: string) => boolean;
  /** Register lifecycle observers for turns belonging to this channel. */
  setLifecycle: (lifecycle: unknown) => void;
  /** Register the channel as the delivery target for its own sessions. */
  setDeliverer: (deliver: (text: string, turnId?: string) => Promise<unknown>) => void;
};

export type IntegrationRuntimeContext = {
  config: Config;
  /** Sub-config from `config.toml`, resolved via the manifest's `config_key`. */
  settings: unknown;
  /** Absolute path of the integration's own directory. */
  dir: string;
  /**
   * Inject a one-shot system event into a session — the mechanism watchers use
   * to wake the model when a condition fires (price cross, data trigger).
   */
  fireSystemEvent: (sessionKey: SessionKey, systemEvent: string) => void;
  /** True while any pooled Claude worker is mid-turn; for deferring restarts. */
  isBusy: () => boolean;
  /** Present only for integrations the host grants channel access to. */
  channel?: ChannelCapabilities;
};

/** Handle returned by a runtime factory so the daemon can shut it down. */
export type IntegrationRuntime = {
  stop: () => void | Promise<void>;
};

export type StartedRuntime = {
  name: string;
  runtime: IntegrationRuntime;
};

/** Read the integration's slice of `config.toml`, per its `config_key`. */
function settingsFor(entry: LoadedIntegration, config: Config): unknown {
  const key = entry.manifest.config_key;
  if (!key) return undefined;
  return (config as unknown as Record<string, unknown>)[key];
}

/**
 * True when an integration should be skipped because its config section says
 * so. Integrations keep their existing `[section].enabled` semantics, so a
 * manifest does not have to duplicate a switch the operator already knows.
 */
function disabledByConfig(entry: LoadedIntegration, config: Config): boolean {
  const settings = settingsFor(entry, config);
  if (settings && typeof settings === "object" && "enabled" in settings) {
    return (settings as { enabled?: boolean }).enabled === false;
  }
  return false;
}

/**
 * Collect MCP tools from every enabled integration the caller's session may
 * reach. `toolCtx` is the harness `ToolContext`, passed through untouched —
 * integrations receive the same context core tools do.
 *
 * Failures are contained per-integration: a package that throws while building
 * its tool list is logged and skipped, and the rest of the harness still gets
 * its tools. A broken plugin degrades the surface, it does not break the turn.
 */
export async function collectIntegrationTools<T>(
  toolCtx: unknown,
  access: AccessInput,
  config: Config,
): Promise<T[]> {
  const registry = getRegistry();
  const out: T[] = [];

  for (const entry of registry.enabled()) {
    const { manifest } = entry;
    if (manifest.tools.length === 0) continue;
    if (disabledByConfig(entry, config)) continue;

    const gate = resolveAccess(manifest, access);
    if (!gate.allowed) {
      log.debug("integrations", "tools withheld", {
        integration: manifest.name,
        why: explainDenial(manifest.name, gate.reason),
      });
      continue;
    }

    const mod = await registry.importModule(manifest.name, TOOLS_FILE);
    if (!mod) continue;

    for (const group of manifest.tools) {
      // A group may carve out narrower access than the integration as a whole
      // (e.g. expose read-only tools broadly, writes only to the owner).
      if (group.access) {
        const groupGate = resolveAccess(manifest, access, group.access);
        if (!groupGate.allowed) continue;
      }
      const factory = mod[group.export_name];
      if (typeof factory !== "function") {
        log.warn("integrations", "declared tool export not found", {
          integration: manifest.name,
          export: group.export_name,
        });
        continue;
      }
      try {
        const tools = (factory as (ctx: unknown) => T[])(toolCtx);
        if (Array.isArray(tools)) out.push(...tools);
      } catch (err) {
        log.error("integrations", "tool factory threw", {
          integration: manifest.name,
          export: group.export_name,
          err: (err as Error).message,
        });
      }
    }
  }

  return out;
}

/**
 * Start the daemon-side runtime of every enabled integration that declares
 * one. Returns handles for shutdown. Runtimes marked `lazy` are skipped here
 * and started on first use by their own tools.
 */
export async function startIntegrationRuntimes(
  ctx: Omit<IntegrationRuntimeContext, "settings" | "dir">,
): Promise<StartedRuntime[]> {
  const registry = getRegistry();
  const started: StartedRuntime[] = [];

  for (const entry of registry.enabled()) {
    const { manifest } = entry;
    const exportName = manifest.runtime.export_name;
    if (!exportName || manifest.runtime.lazy) continue;
    if (disabledByConfig(entry, ctx.config)) {
      log.info("integrations", "runtime skipped (disabled in config.toml)", {
        integration: manifest.name,
        config_key: manifest.config_key,
      });
      continue;
    }

    const mod = await registry.importModule(manifest.name, INDEX_FILE);
    if (!mod) continue;
    const factory = mod[exportName];
    if (typeof factory !== "function") {
      log.warn("integrations", "declared runtime export not found", {
        integration: manifest.name,
        export: exportName,
      });
      continue;
    }

    try {
      const runtime = await (
        factory as (
          c: IntegrationRuntimeContext,
        ) => Promise<IntegrationRuntime> | IntegrationRuntime
      )({
        ...ctx,
        settings: settingsFor(entry, ctx.config),
        dir: entry.dir,
      });
      if (runtime && typeof runtime.stop === "function") {
        started.push({ name: manifest.name, runtime });
        log.info("integrations", "runtime started", { integration: manifest.name });
      }
    } catch (err) {
      // A plugin that cannot start must not prevent the daemon from booting.
      log.error("integrations", "runtime failed to start", {
        integration: manifest.name,
        err: (err as Error).message,
      });
    }
  }

  return started;
}

/** Stop every started runtime, isolating failures so one hang can't block the rest. */
export async function stopIntegrationRuntimes(started: StartedRuntime[]): Promise<void> {
  for (const { name, runtime } of started) {
    try {
      await runtime.stop();
    } catch (err) {
      log.warn("integrations", "runtime stop threw", {
        integration: name,
        err: (err as Error).message,
      });
    }
  }
}

/**
 * Model-facing instructions contributed by integrations this session can
 * reach. Appended to the system prompt so an integration's guidance travels
 * with the package instead of being hardcoded in the prompt builder.
 */
export function collectIntegrationInstructions(access: AccessInput, config: Config): string[] {
  const registry = getRegistry();
  const blocks: string[] = [];

  for (const entry of registry.enabled()) {
    const { manifest } = entry;
    const { instructions } = manifest;
    if (!instructions.system_prompt_file && !instructions.envelope_note) continue;
    if (disabledByConfig(entry, config)) continue;
    if (!resolveAccess(manifest, access).allowed) continue;

    if (instructions.system_prompt_file) {
      const path = registry.resolvePath(manifest.name, instructions.system_prompt_file);
      if (path) {
        try {
          blocks.push(readFileSync(path, "utf8").trim());
        } catch (err) {
          log.warn("integrations", "could not read instructions file", {
            integration: manifest.name,
            err: (err as Error).message,
          });
        }
      }
    }
    if (instructions.envelope_note) blocks.push(instructions.envelope_note.trim());
  }

  return blocks.filter(Boolean);
}

/**
 * Skills that belong to an integration which is NOT available right now —
 * either its package is absent from this checkout or its config table turned
 * it off. The skill tools hide these so the model never reads a skill that
 * routes work at tools it cannot call.
 *
 * Sourced from each manifest's `instructions.skills`. Before this, core
 * hardcoded `name.startsWith("radaromega")` against `[radaromega].enabled` —
 * which silently did nothing for any other integration, and had to be edited
 * in two places every time one was added.
 */
export function unavailableIntegrationSkills(config: Config): Set<string> {
  const hidden = new Set<string>();
  const registry = getRegistry();
  const available = new Set(
    registry
      .enabled()
      .filter((e) => !disabledByConfig(e, config))
      .map((e) => e.manifest.name),
  );

  for (const entry of registry.all()) {
    if (available.has(entry.manifest.name)) continue;
    for (const skill of entry.manifest.instructions.skills ?? []) hidden.add(skill);
  }
  return hidden;
}
