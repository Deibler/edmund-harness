import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import * as intSettings from "../../src/integrations/settings.ts";
import { color, info, warn } from "../ui.ts";
import type { Svc } from "./launchctl.ts";
import { REPO } from "./paths.ts";

type RadarOmegaState = {
  enabled: boolean;
  running: boolean;
  cdpUrl: string;
  launchScript: string;
  reason?: string;
};

export async function ensureRadarOmegaForService(svc: Svc): Promise<void> {
  if (svc !== "harness") return;

  const state = await radarOmegaState();
  if (!state.enabled) return;
  if (state.running) {
    info(`RadarOmega CDP already reachable at ${color.cyan(state.cdpUrl)}.`);
    return;
  }
  if (!existsSync(state.launchScript)) {
    warn(`RadarOmega enabled, but launch script is missing: ${state.launchScript}`);
    return;
  }

  info(`starting RadarOmega with CDP at ${color.cyan(state.cdpUrl)}.`);
  const child = spawn(state.launchScript, [String(intSettings.radaromega(loadConfig()).cdp_port)], {
    cwd: REPO,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const ready = await waitForCdp(state.cdpUrl, 20_000);
  if (ready) {
    info("RadarOmega CDP is ready.");
  } else {
    warn(
      "RadarOmega launched, but CDP did not answer within 20s. If the app is still loading or needs login, Edmund will connect later when it is ready.",
    );
  }
}

async function radarOmegaState(): Promise<RadarOmegaState> {
  // Opaque section: read via settings.ts so a checkout without the
  // radaromega package (and without its [radaromega] table) still works.
  const ro = intSettings.radaromega(loadConfig());
  const packagePath = resolve(ro.package_path);
  const cdpUrl = `http://127.0.0.1:${ro.cdp_port}/json`;
  const launchScript = resolve(packagePath, "launch.sh");
  return {
    enabled: ro.enabled,
    running: ro.enabled ? await canReachCdp(cdpUrl) : false,
    cdpUrl,
    launchScript,
  };
}

async function waitForCdp(cdpUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canReachCdp(cdpUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function canReachCdp(cdpUrl: string): Promise<boolean> {
  try {
    const res = await fetch(cdpUrl, { signal: AbortSignal.timeout(750) });
    return res.ok;
  } catch {
    return false;
  }
}
