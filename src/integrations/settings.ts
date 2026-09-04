/**
 * Reading integration config sections from core.
 *
 * Core keeps `[trading]`, `[mirror]`, `[radaromega]`, `[fishing]`, and
 * `[cloudflare]` as opaque values — their schemas live with their packages, so
 * core cannot (and must not) import them. But a handful of core paths still
 * need a value out of one: the MCP loadout builder needs the Robinhood URL,
 * the model resolver needs the trading model override, the skill filter needs
 * to know whether RadarOmega is on.
 *
 * `section()` reads those as plain data with a caller-declared shape. It is
 * deliberately NOT a validating parse: core does not own these schemas and
 * should not assert their contents. The integration validates properly when it
 * loads its own config; core just reads a field and falls back if absent.
 *
 * The fields core reads this way are the integration's public config surface —
 * renaming one is a breaking change for the harness, same as renaming an
 * exported function. Keep the set small.
 */

import type { Config } from "../config/config.ts";

/**
 * Narrow an opaque integration config section to the shape the caller needs.
 * Returns an empty object when the section is missing, so every read is
 * `section<T>(config, "x").field ?? fallback` and never throws on a checkout
 * where that integration (and its config table) is absent.
 */
function section<T extends object>(config: Config, key: string): Partial<T> {
  const raw = (config as unknown as Record<string, unknown>)[key];
  return (raw && typeof raw === "object" ? raw : {}) as Partial<T>;
}

/** Shapes core reads. Each mirrors a subset of the integration's own schema. */

export type TradingSection = {
  enabled: boolean;
  model: string;
  effort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  account_number: string;
  cash_floor: number;
  max_position_pct: number;
  max_order_usd: number;
  max_orders_per_run: number;
  kill_nav: number;
  prefer_limit: boolean;
  universe: string;
  mcp_url: string;
  mcp_headers: Record<string, string>;
  mcp_servers: Record<string, unknown>;
  dashboard_port: number;
};

export type MirrorSection = {
  enabled: boolean;
  session_key: string;
  model: string;
  effort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  default_ttl_seconds: number;
};

export type RadarOmegaSection = {
  enabled: boolean;
  package_path: string;
  cdp_port: number;
};

export type FishingSection = {
  enabled: boolean;
  api_url: string;
};

export type CloudflareSection = {
  account_id: string;
  api_token: string;
};

/**
 * Defaults applied when a section (or a field in it) is absent — i.e. when the
 * integration is not installed, or its table is missing from config.toml.
 * These are the "integration absent" values, chosen so core behaves as though
 * the capability simply does not exist: disabled, no credentials, no override.
 *
 * They intentionally do NOT duplicate the integration's own defaults for
 * tunables. The integration validates its real config with its own schema; core
 * only needs a well-typed value here so a missing table cannot crash a turn.
 */
const TRADING_DEFAULTS: TradingSection = {
  enabled: false,
  model: "",
  effort: "",
  account_number: "",
  cash_floor: 0,
  max_position_pct: 0,
  max_order_usd: 0,
  max_orders_per_run: 0,
  kill_nav: 0,
  prefer_limit: true,
  universe: "",
  mcp_url: "",
  mcp_headers: {},
  mcp_servers: {},
  // Port defaults mirror the integration's own schema so the CLI's port
  // preflight has a number to check even when the table is absent.
  dashboard_port: 4848,
};

const MIRROR_DEFAULTS: MirrorSection = {
  enabled: false,
  session_key: "",
  model: "",
  effort: "",
  default_ttl_seconds: 300,
};

const RADAROMEGA_DEFAULTS: RadarOmegaSection = {
  enabled: false,
  package_path: "./vendor/radaromega-mcp",
  cdp_port: 9222,
};

const FISHING_DEFAULTS: FishingSection = {
  enabled: false,
  api_url: "http://127.0.0.1:8087/api/v1",
};

const CLOUDFLARE_DEFAULTS: CloudflareSection = { account_id: "", api_token: "" };

/** Merge the raw section over its absent-integration defaults. */
function withDefaults<T extends object>(config: Config, key: string, defaults: T): T {
  return { ...defaults, ...section<T>(config, key) } as T;
}

export const trading = (c: Config) => withDefaults(c, "trading", TRADING_DEFAULTS);
export const mirror = (c: Config) => withDefaults(c, "mirror", MIRROR_DEFAULTS);
export const radaromega = (c: Config) => withDefaults(c, "radaromega", RADAROMEGA_DEFAULTS);
export const fishing = (c: Config) => withDefaults(c, "fishing", FISHING_DEFAULTS);
export const cloudflare = (c: Config) => withDefaults(c, "cloudflare", CLOUDFLARE_DEFAULTS);
