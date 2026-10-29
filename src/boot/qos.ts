/**
 * Whether the daemon runs at background QoS. launchd's `ProcessType
 * Background` puts the daemon, and every process it spawns (model workers, MCP
 * servers, Messages), in the lowest scheduling band: efficiency cores and
 * throttled I/O. Nothing looks wrong from inside; the machine just seems idle.
 * From 2026-10-25 a reinstall re-rendered the plist from a template that still
 * said Background, and a worker's load went from 2.0-2.4 s to 5.6-6.1 s on the
 * same conversation. `ps` reports that band as priority 4.
 */

import { spawnSync } from "node:child_process";

export const BACKGROUND_PRI = 4;

/** The process's scheduling priority as `ps` reports it, or null if unreadable. */
export function schedulingPriority(pid = process.pid): number | null {
  const run = spawnSync("/bin/ps", ["-o", "pri=", "-p", String(pid)], { encoding: "utf8" });
  const n = Number.parseInt((run.stdout ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** The boot warning for a throttled daemon, or null when it runs normally. */
export function throttledQosWarning(pri: number | null): string | null {
  if (pri === null || pri > BACKGROUND_PRI) return null;
  return `daemon runs at background QoS (ps pri=${pri}): model workers, MCP servers and Messages get efficiency cores and throttled I/O. Set ProcessType Interactive in the launchd plist and run scripts/launchd/service.sh install`;
}
