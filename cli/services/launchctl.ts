/**
 * launchctl + service.sh wrapper. One place to call shell, one place to parse
 * launchctl's output format.
 */

import { spawnSync } from "node:child_process";
import {
  DASHBOARD_LABEL,
  FISHING_LABEL,
  HARNESS_LABEL,
  REPO,
  SERVICE_SH,
  TRADING_LABEL,
} from "./paths.ts";

export type Svc = "harness" | "dashboard" | "trading" | "fishing";

export type SvcState = {
  label: string;
  loaded: boolean;
  running: boolean;
  pid: number | null;
  lastExit: number | null;
};

function labelFor(svc: Svc): string {
  if (svc === "harness") return HARNESS_LABEL;
  if (svc === "trading") return TRADING_LABEL;
  if (svc === "fishing") return FISHING_LABEL;
  return DASHBOARD_LABEL;
}

/**
 * service.sh argv prefix for a service's op. The harness is the bare verb
 * (`install`); dashboard and trading are namespaced (`dashboard install`,
 * `trading install`).
 */
function svcArgs(svc: Svc, op: string): string[] {
  return svc === "harness" ? [op] : [svc, op];
}

function domain(): string {
  const uid = spawnSync("id", ["-u"]).stdout.toString().trim();
  return `gui/${uid}`;
}

export function svcState(svc: Svc): SvcState {
  const label = labelFor(svc);
  const r = spawnSync("launchctl", ["print", `${domain()}/${label}`], { encoding: "utf8" });
  if (r.status !== 0) {
    return { label, loaded: false, running: false, pid: null, lastExit: null };
  }
  const raw = r.stdout;
  const pidM = raw.match(/pid\s*=\s*(\d+)/);
  const stateM = raw.match(/state\s*=\s*(\w+)/);
  const exitM = raw.match(/last exit code\s*=\s*(-?\d+)/);
  return {
    label,
    loaded: true,
    running: stateM?.[1] === "running",
    pid: pidM?.[1] ? Number.parseInt(pidM[1], 10) : null,
    lastExit: exitM?.[1] ? Number.parseInt(exitM[1], 10) : null,
  };
}

export function localPids(svc: Svc): number[] {
  const pattern =
    svc === "harness"
      ? "bun run.*src/main.ts"
      : svc === "trading"
        ? "bun.*integrations/trading/dashboard/main.ts"
        : svc === "fishing"
          ? "fishctl serve"
          : "bun.*dashboard/server/main.ts";
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout
    .trim()
    .split("\n")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

function runService(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("/bin/bash", [SERVICE_SH, ...args], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 20_000,
  });
  return {
    ok: r.status === 0,
    out: [r.stdout, r.stderr].filter(Boolean).join("\n").trim(),
  };
}

export function install(svc: Svc): { ok: boolean; out: string } {
  const r = runService(...svcArgs(svc, "install"));
  // service.sh ends with a status grep that can exit nonzero when grep has
  // no matches (transient state right after kickstart). Trust launchctl
  // print over the shell exit code so we don't report a successful install
  // as a failure.
  const st = svcState(svc);
  if (st.loaded) return { ok: true, out: r.out };
  return r;
}

export function uninstall(svc: Svc): { ok: boolean; out: string } {
  return runService(...svcArgs(svc, "uninstall"));
}

export function start(svc: Svc): { ok: boolean; out: string } {
  return runService(...svcArgs(svc, "start"));
}

export function stop(svc: Svc): { ok: boolean; out: string } {
  return runService(...svcArgs(svc, "stop"));
}

export function restart(svc: Svc): { ok: boolean; out: string } {
  return runService(...svcArgs(svc, "restart"));
}

export function killLocalPids(svc: Svc): number {
  const pids = localPids(svc);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  return pids.length;
}
