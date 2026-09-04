/**
 * `edmund dashboard` — quick info about the dashboard service.
 * `edmund dashboard --pin <pin>` — update the login PIN.
 * `edmund dashboard --logs [--follow]` — tail dashboard.log.
 */

import { spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import type { Parsed } from "../args.ts";
import { getString, hasFlag } from "../args.ts";
import * as ctl from "../services/launchctl.ts";
import { REPO } from "../services/paths.ts";
import { badge, color, fail, info, kv, ok, print, section } from "../ui.ts";
import { logsCommand } from "./logs.ts";

export async function dashboardCommand(p: Parsed): Promise<void> {
  const pin = getString(p, "pin");
  const wantLogs = hasFlag(p, "logs");

  if (pin) {
    return setPin(pin);
  }
  if (wantLogs) {
    // Rewire to logs --dashboard so all formatting stays in one place.
    return logsCommand({ ...p, flags: { ...p.flags, dashboard: true } });
  }

  await showInfo();
}

function setPin(pin: string): void {
  if (!/^[A-Za-z0-9 !@#$%^&*()_+=.,:;?-]{4,64}$/.test(pin)) {
    fail("PIN must be 4 to 64 characters: letters, digits, spaces and common punctuation.");
    process.exit(2);
  }
  const script = resolve(REPO, "dashboard/server/scripts/setPin.ts");
  const r = spawnSync("/opt/homebrew/bin/bun", ["run", script, pin], {
    cwd: REPO,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    fail("failed to update PIN.");
    process.exit(r.status ?? 1);
  }
  ok(`PIN updated. Existing cookies remain valid until they expire.`);
  info(`restart the dashboard:  ${color.cyan("edmund restart --dashboard")}`);
}

async function showInfo(): Promise<void> {
  const cfg = loadConfig();
  const st = ctl.svcState("dashboard");
  section("dashboard");
  kv(
    "state",
    st.running
      ? badge("● running", "ok")
      : st.loaded
        ? badge("○ loaded", "warn")
        : badge("○ stopped", "muted"),
  );
  kv("port", cfg.dashboard.port);
  kv("bind", cfg.dashboard.bind);
  kv(
    "pin",
    cfg.dashboard.pin_hash
      ? badge("set", "ok")
      : badge("NOT set (run `edmund dashboard --pin <pin>`)", "warn"),
  );

  const urls = buildUrls(cfg.dashboard.bind, cfg.dashboard.port);
  section("urls");
  for (const u of urls) print(`  ${color.cyan(u)}`);
  print("");
}

function buildUrls(bind: string, port: number): string[] {
  const urls: string[] = [];
  urls.push(`http://localhost:${port}`);
  if (bind === "0.0.0.0") {
    for (const addr of lanAddresses()) urls.push(`http://${addr}:${port}`);
  }
  return urls;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
