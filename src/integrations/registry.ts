/**
 * Integration registry — discovery, manifest loading, and lazy module import.
 *
 * The registry is the only thing in the harness that knows integrations exist
 * as a category. Core code never imports `integrations/<name>/…` directly;
 * it asks the registry for tools or a runtime handle and gets back whatever
 * happens to be installed. That indirection is what lets an integration
 * directory be deleted from a checkout without touching core source.
 *
 * Discovery is filesystem-driven: every subdirectory of `integrations/` that
 * contains a `manifest.yaml` is a candidate. The top-level
 * `integrations-config.yaml` then decides which candidates are actually on,
 * and may override per-integration settings for this deployment.
 *
 * Module import is LAZY and per-surface. Reading a manifest costs a small YAML
 * parse; importing an integration's TypeScript costs whatever its dependency
 * tree costs. So `load()` reads manifests only, and the actual `import()`
 * happens the first time someone asks for that integration's tools or runtime.
 * A daemon with mirror disabled never evaluates the mirror bridge module.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { log } from "../util/log.ts";
import { type IntegrationsConfig, TopLevelConfigSchema } from "./config.ts";
import { type Manifest, parseManifest } from "./manifest.ts";

/** Repo root — `src/integrations/` is two levels below it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEFAULT_INTEGRATIONS_DIR = join(REPO_ROOT, "integrations");
const MANIFEST_FILE = "manifest.yaml";
const CONFIG_FILE = "integrations-config.yaml";

/** A discovered integration: its manifest plus where it lives on disk. */
export type LoadedIntegration = {
  manifest: Manifest;
  /** Absolute path of the integration directory. */
  dir: string;
  /** Absolute path of its manifest, for error messages. */
  manifestPath: string;
};

export type LoadOptions = {
  /** Override the integrations directory (from `[integrations].dir`, or tests). */
  dir?: string;
  /**
   * Override the operator config file. Defaults to `integrations-config.yaml`
   * inside the integrations directory; `[integrations].config_file` can point
   * it elsewhere (e.g. a machine-specific store outside the repo).
   */
  configFile?: string;
  /**
   * Skip the top-level config file. Used by tests and by
   * `edmund integrations list --all`, which wants to see every package on
   * disk regardless of whether this deployment enables it.
   */
  ignoreTopLevelConfig?: boolean;
};

export class IntegrationRegistry {
  private integrations = new Map<string, LoadedIntegration>();
  /** Cache of imported modules, keyed `<name>:<file>`. */
  private moduleCache = new Map<string, Promise<Record<string, unknown>>>();
  private topLevel: IntegrationsConfig = { integrations: {}, defaults: {} };
  private dir: string;

  constructor(private opts: LoadOptions = {}) {
    this.dir = opts.dir ?? DEFAULT_INTEGRATIONS_DIR;
  }

  /**
   * Discover every integration on disk and apply the top-level config. Safe to
   * call when `integrations/` does not exist — a checkout with no integrations
   * is a valid harness, it just has no plugin tools.
   */
  load(): this {
    if (!this.opts.ignoreTopLevelConfig) this.loadTopLevelConfig();
    if (!existsSync(this.dir)) {
      log.debug("integrations", "no integrations directory; running core-only", {
        dir: this.dir,
      });
      return this;
    }

    let entries: string[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch (err) {
      log.warn("integrations", "could not read integrations directory", {
        dir: this.dir,
        err: (err as Error).message,
      });
      return this;
    }

    for (const name of entries) {
      const dir = join(this.dir, name);
      const manifestPath = join(dir, MANIFEST_FILE);
      if (!existsSync(manifestPath)) continue; // not an integration, just a folder
      try {
        const raw = parseYaml(readFileSync(manifestPath, "utf8"));
        const manifest = this.applyOverrides(parseManifest(raw, manifestPath));
        if (manifest.name !== name) {
          // A mismatch makes `requires` and config lookups silently wrong, so
          // it is worth failing loudly at load rather than debugging later.
          log.warn("integrations", "manifest name does not match directory; skipping", {
            dir: name,
            manifest_name: manifest.name,
          });
          continue;
        }
        this.integrations.set(name, { manifest, dir, manifestPath });
      } catch (err) {
        // One malformed manifest must not take down every other integration.
        log.error("integrations", "failed to load manifest", {
          path: manifestPath,
          err: (err as Error).message,
        });
      }
    }

    this.verifyRequirements();

    const on = this.enabled().map((i) => i.manifest.name);
    const off = this.all()
      .filter((i) => !i.manifest.enabled)
      .map((i) => i.manifest.name);
    log.info("integrations", `loaded ${this.integrations.size}`, {
      enabled: on.length > 0 ? on.join(", ") : "(none)",
      ...(off.length > 0 ? { disabled: off.join(", ") } : {}),
    });
    return this;
  }

  private loadTopLevelConfig(): void {
    const path = this.opts.configFile
      ? resolve(REPO_ROOT, this.opts.configFile)
      : join(this.dir, CONFIG_FILE);
    if (!existsSync(path)) return;
    try {
      const raw = parseYaml(readFileSync(path, "utf8"));
      this.topLevel = TopLevelConfigSchema.parse(raw ?? {});
    } catch (err) {
      log.error("integrations", "invalid integrations-config.yaml; using manifest defaults", {
        path,
        err: (err as Error).message,
      });
    }
  }

  /**
   * Apply deployment overrides from `integrations-config.yaml` on top of the
   * manifest's own values. The manifest is the package's declaration of intent;
   * the top-level file is the operator's say over this particular machine.
   */
  private applyOverrides(manifest: Manifest): Manifest {
    const defaults = this.topLevel.defaults ?? {};
    const override = this.topLevel.integrations?.[manifest.name];
    let enabled = manifest.enabled;
    if (typeof defaults.enabled === "boolean") enabled = defaults.enabled;
    if (override && typeof override.enabled === "boolean") enabled = override.enabled;

    const access = override?.access
      ? {
          ...manifest.access,
          ...override.access,
        }
      : manifest.access;

    return { ...manifest, enabled, access };
  }

  /** Warn about `requires:` entries that are missing or disabled. */
  private verifyRequirements(): void {
    for (const { manifest } of this.integrations.values()) {
      if (!manifest.enabled) continue;
      for (const dep of manifest.requires) {
        const found = this.integrations.get(dep);
        if (!found || !found.manifest.enabled) {
          log.warn("integrations", "unmet requirement — disabling dependent", {
            integration: manifest.name,
            requires: dep,
            reason: found ? "dependency disabled" : "dependency not installed",
          });
          manifest.enabled = false;
        }
      }
    }
  }

  /** Every integration found on disk, enabled or not. */
  all(): LoadedIntegration[] {
    return [...this.integrations.values()];
  }

  /** Only integrations whose manifests are enabled for this deployment. */
  enabled(): LoadedIntegration[] {
    return this.all().filter((i) => i.manifest.enabled);
  }

  get(name: string): LoadedIntegration | null {
    return this.integrations.get(name) ?? null;
  }

  /** True when an enabled integration claims this session namespace. */
  ownerOfNamespace(namespace: string): LoadedIntegration | null {
    return this.enabled().find((i) => i.manifest.session_namespace === namespace) ?? null;
  }

  /**
   * Import a file from an integration package, memoized. Returns null when the
   * integration is absent/disabled or the file cannot be imported — callers
   * treat a null module as "this integration contributes nothing", which is
   * exactly the behavior for an uninstalled package.
   */
  async importModule(name: string, file: string): Promise<Record<string, unknown> | null> {
    const entry = this.integrations.get(name);
    if (!entry || !entry.manifest.enabled) return null;
    const cacheKey = `${name}:${file}`;
    const cached = this.moduleCache.get(cacheKey);
    if (cached) return cached;

    const path = join(entry.dir, file);
    if (!existsSync(path)) {
      log.warn("integrations", "declared module missing", { integration: name, file });
      return null;
    }
    const promise = import(path).catch((err) => {
      log.error("integrations", "module import failed", {
        integration: name,
        file,
        err: (err as Error).message,
      });
      throw err;
    }) as Promise<Record<string, unknown>>;
    this.moduleCache.set(cacheKey, promise);
    try {
      return await promise;
    } catch {
      // Drop the rejected promise so a transient failure can be retried
      // instead of being cached as permanently broken.
      this.moduleCache.delete(cacheKey);
      return null;
    }
  }

  /** Resolve a path inside an integration package (e.g. an instructions file). */
  resolvePath(name: string, relative: string): string | null {
    const entry = this.integrations.get(name);
    if (!entry) return null;
    const path = join(entry.dir, relative);
    return existsSync(path) ? path : null;
  }
}

/**
 * Process-wide registry. Built once on first use so the daemon, the MCP
 * subprocess, and the CLI all observe the same view without threading a
 * handle through every call site.
 */
let shared: IntegrationRegistry | null = null;

export function getRegistry(opts?: LoadOptions): IntegrationRegistry {
  if (!shared) shared = new IntegrationRegistry(opts).load();
  return shared;
}

/**
 * Build the shared registry from `[integrations]` in config.toml. Call once at
 * startup (daemon and MCP subprocess each do this) BEFORE anything asks for
 * tools or runtimes, so the configured directory and operator store are the
 * ones actually used. Idempotent — a second call is a no-op.
 *
 * With `[integrations].enabled = false` the registry loads empty: the harness
 * runs core-only, which is a supported configuration rather than an error.
 */
export function initRegistryFromConfig(cfg: {
  integrations?: { enabled?: boolean; dir?: string; config_file?: string };
}): IntegrationRegistry {
  if (shared) return shared;
  const settings = cfg.integrations;
  if (settings && settings.enabled === false) {
    shared = new IntegrationRegistry({ dir: join(REPO_ROOT, "__no_integrations__") }).load();
    return shared;
  }
  shared = new IntegrationRegistry({
    dir: settings?.dir ? resolve(REPO_ROOT, settings.dir) : undefined,
    configFile: settings?.config_file,
  }).load();
  return shared;
}
