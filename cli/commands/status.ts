/**
 * `edmund status` — one glance: both launchd states, local strays, log paths.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import type { Parsed } from "../args.ts";
import * as ctl from "../services/launchctl.ts";
import type { Svc } from "../services/launchctl.ts";
import { DAEMON_LOG, DASHBOARD_LOG, FISHING_LOG, REPO, TRADING_LOG } from "../services/paths.ts";
import { classifyHolders, findPortPids } from "../services/ports.ts";
import { servicePort, serviceSignature } from "../services/preflight.ts";
import { prettyName, resolveTargets } from "../services/target.ts";
import { badge, color, kv, print, section } from "../ui.ts";

const CONFIG_PATH = resolve(REPO, "config.toml");

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function getPidStartTime(pid: number): Date | null {
  // `ps -p <pid> -o lstart=` returns the human-readable start time on macOS
  const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const d = new Date(r.stdout.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function getLanAddresses(): string[] {
  const ifaces = networkInterfaces();
  const addrs: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        addrs.push(iface.address);
      }
    }
  }
  return addrs;
}

function svcBadge(st: ctl.SvcState, local: number[]): string {
  if (st.running) return badge("● running", "ok");
  if (st.loaded) return badge("○ loaded, not running", "warn");
  if (local.length > 0) return badge("⚠ local only (not launchd)", "warn");
  return badge("○ stopped", "muted");
}

function showSvc(svc: Svc): void {
  const st = ctl.svcState(svc);
  const local = ctl.localPids(svc).filter((p) => p !== process.pid);
  section(prettyName(svc));
  kv("state", svcBadge(st, local));
  kv("label", color.dim(st.label));

  // Uptime from the launchd-managed pid, or from first local pid
  const activePid = st.pid ?? local[0] ?? null;
  if (activePid !== null) {
    kv("pid", String(activePid));
    const started = getPidStartTime(activePid);
    if (started) {
      const uptime = formatUptime(Date.now() - started.getTime());
      kv("uptime", `${color.cyan(uptime)}  ${color.dim(`since ${started.toLocaleString()}`)}`);
    }
  } else {
    kv("pid", null);
  }

  kv("last exit", st.lastExit ?? null);
  if (local.length > 0 && st.pid === null) {
    kv("local pids", local.join(", "));
  }

  const cfg0 = svc !== "harness" ? loadConfig() : null;
  const port = cfg0 ? servicePort(svc, cfg0) : null;
  if (port !== null) {
    const signature = serviceSignature(svc);
    const ownPids = [st.pid, ...local].filter((n): n is number => typeof n === "number");
    const classified = classifyHolders(findPortPids(port), ownPids, signature);
    const strays = classified.filter((h) => h.ownership === "stray");
    const foreign = classified.filter((h) => h.ownership === "foreign");
    if (strays.length > 0) {
      const detail = strays.map((h) => `${h.pid}`).join(", ");
      kv("port", `${port}  ${color.yellow(`stray procs: ${detail}`)}`);
    } else if (foreign.length > 0) {
      const detail = foreign.map((h) => `${h.pid} (${h.command.slice(0, 40)})`).join(", ");
      kv("port", `${port}  ${color.red(`blocked by: ${detail}`)}`);
    } else if (classified.length > 0) {
      kv("port", `${port}  ${color.dim("(held by this service)")}`);
    } else {
      kv("port", `${port}  ${color.dim("(free)")}`);
    }

    // Dashboard URL(s)
    if (st.running || local.length > 0) {
      const lanAddrs = getLanAddresses();
      const urls = lanAddrs.map((a) => `http://${a}:${port}`);
      if (urls.length > 0) {
        kv(
          "url",
          color.cyan(urls[0] ?? "") +
            (urls.length > 1 ? color.dim(`  +${urls.length - 1} more`) : ""),
        );
      }
      kv("localhost", color.cyan(`http://localhost:${port}`));
    }
  }

  // Config.toml last-modified
  if (existsSync(CONFIG_PATH)) {
    const cfgStat = statSync(CONFIG_PATH);
    kv(
      "config.toml",
      `${color.dim(formatRelative(cfgStat.mtimeMs))}  ${color.dim(new Date(cfgStat.mtimeMs).toLocaleString())}`,
    );
  }

  const logPath =
    svc === "harness"
      ? DAEMON_LOG
      : svc === "trading"
        ? TRADING_LOG
        : svc === "fishing"
          ? FISHING_LOG
          : DASHBOARD_LOG;
  if (existsSync(logPath)) {
    const s = statSync(logPath);
    kv("log", `${color.dim(logPath)}  ${color.dim(formatSize(s.size))}`);
  } else {
    kv("log", color.dim(logPath));
  }
}

export async function statusCommand(p: Parsed): Promise<void> {
  const targets = resolveTargets(p);
  for (const svc of targets) showSvc(svc);
  print("");
}
