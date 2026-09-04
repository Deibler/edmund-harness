/**
 * Pre-start checks. Today: make sure the dashboard port is free before we
 * hand off to launchd or exec locally. Extend here if other services grow
 * their own preflight needs.
 */

import { loadConfig } from "../../src/config/config.ts";
import * as intSettings from "../../src/integrations/settings.ts";
import { color, fail, info, warn } from "../ui.ts";
import type { Svc } from "./launchctl.ts";
import { svcState } from "./launchctl.ts";
import { classifyHolders, ensurePortFree, findPortPids } from "./ports.ts";

/** Matches any process running our port-bound service entry points. */
const DASHBOARD_SIGNATURE = /dashboard[/\\]server[/\\]main\.ts/;
const TRADING_SIGNATURE = /integrations[/\\]trading[/\\]dashboard[/\\]main\.ts/;
const FISHING_SIGNATURE = /fishctl serve/;

/** Port a port-bound service listens on (the fishing port is parsed from its URL). */
export function servicePort(svc: Svc, cfg: ReturnType<typeof loadConfig>): number | null {
  if (svc === "dashboard") return cfg.dashboard.port;
  // Integration sections are opaque to core, so read them through settings.ts —
  // it supplies an "integration absent" default instead of throwing when the
  // package (and its config table) has been removed from this checkout.
  if (svc === "trading") return intSettings.trading(cfg).dashboard_port;
  if (svc === "fishing") return Number(new URL(intSettings.fishing(cfg).api_url).port) || 8087;
  return null;
}

export function serviceSignature(svc: Svc): RegExp {
  if (svc === "trading") return TRADING_SIGNATURE;
  if (svc === "fishing") return FISHING_SIGNATURE;
  return DASHBOARD_SIGNATURE;
}

export async function preflight(svc: Svc): Promise<void> {
  if (svc === "harness") return; // no port to guard
  const cfg = loadConfig();
  const port = servicePort(svc, cfg);
  if (port === null) return;
  const SIGNATURE = serviceSignature(svc);
  const state = svcState(svc);
  const ownPids = state.pid ? [state.pid] : [];

  const held = findPortPids(port);
  if (held.length === 0) return;
  const classified = classifyHolders(held, ownPids, SIGNATURE);
  const strays = classified.filter((h) => h.ownership === "stray");
  const foreign = classified.filter((h) => h.ownership === "foreign");

  // Foreign processes on the same port: fatal. Don't SIGTERM a macOS daemon.
  if (foreign.length > 0) {
    fail(`port ${port} is held by an unrelated process — refusing to kill it.`);
    for (const h of foreign) {
      info(`  ${color.dim(`pid ${h.pid}:`)} ${color.dim(h.command.slice(0, 90))}`);
    }
    if (svc === "fishing") {
      info(`free port ${port} or change the fishing API port (then update [fishing] api_url).`);
    } else {
      info(`pick a different port in  ${color.cyan(`[${svc}] port`)}  of config.toml.`);
    }
    process.exit(1);
  }

  if (strays.length === 0) return;

  warn(`port ${port} is held by ${strays.length} stray ${svc} process(es):`);
  for (const h of strays) {
    info(`  ${color.dim(`pid ${h.pid}:`)} ${color.dim(h.command.slice(0, 90))}`);
  }
  const { killed, stillHeldBy } = await ensurePortFree(port, ownPids, SIGNATURE);
  if (stillHeldBy.length > 0) {
    fail(`port ${port} is STILL held by ${stillHeldBy.join(", ")} — aborting start.`);
    info(`inspect with:  ${color.cyan(`lsof -iTCP:${port} -sTCP:LISTEN`)}`);
    process.exit(1);
  }
  if (killed.length > 0) {
    info(`freed port ${port} (killed pid(s) ${killed.join(", ")}).`);
  }
}
