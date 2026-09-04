/**
 * Port helpers — find whoever is holding a TCP port and free it.
 *
 * Used before starting the dashboard so a stray process (previous launchd
 * generation that didn't die, a foregrounded `bun run dashboard:server` the
 * user forgot to Ctrl-C, etc.) can't cause EADDRINUSE at bootstrap time.
 */

import { spawnSync } from "node:child_process";

/**
 * Returns pids currently listening on the given TCP port.
 *
 * Filter form matters: `-iTCP:<port>` AND-s protocol + port. The separated
 * form `-iTCP -i:<port>` is OR-ed by lsof and returns every TCP listener —
 * which is how we ended up flagging rapportd / ControlCenter earlier.
 */
export function findPortPids(port: number): number[] {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return Array.from(
    new Set(
      r.stdout
        .trim()
        .split("\n")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n)),
    ),
  );
}

function describePid(pid: number): string {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "(unknown)";
}

/**
 * Classify port holders as:
 *   - "ours"    — known service pid (e.g., the launchd-managed dashboard)
 *   - "stray"   — looks like our service by cmdline (rogue foreground bun), kill on demand
 *   - "foreign" — unrelated process (macOS daemon, another user tool) — never kill
 */
type PortOwnership = "ours" | "stray" | "foreign";
export type PortHolder = { pid: number; command: string; ownership: PortOwnership };

export function classifyHolders(
  pids: number[],
  ownPids: number[],
  signature: RegExp,
): PortHolder[] {
  return pids.map((pid) => {
    const command = describePid(pid);
    let ownership: PortOwnership = "foreign";
    if (ownPids.includes(pid)) ownership = "ours";
    else if (signature.test(command)) ownership = "stray";
    return { pid, command, ownership };
  });
}

/**
 * Free the port by killing only *stray* holders — processes whose cmdline
 * matches the signature but aren't the launchd-managed pid. Foreign
 * processes on the same port are returned in `blocked` so the caller can
 * tell the user they need to pick a different port rather than silently
 * killing a macOS service.
 */
export async function ensurePortFree(
  port: number,
  ownPids: number[],
  signature: RegExp,
  timeoutMs = 3000,
): Promise<{ killed: number[]; blocked: PortHolder[]; stillHeldBy: number[] }> {
  const classified = classifyHolders(findPortPids(port), ownPids, signature);
  const strays = classified.filter((h) => h.ownership === "stray").map((h) => h.pid);
  const blocked = classified.filter((h) => h.ownership === "foreign");
  if (strays.length === 0) return { killed: [], blocked, stillHeldBy: [] };
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const still = classifyHolders(findPortPids(port), ownPids, signature)
      .filter((h) => h.ownership === "stray")
      .map((h) => h.pid);
    if (still.length === 0) return { killed: strays, blocked, stillHeldBy: [] };
    await new Promise((r) => setTimeout(r, 150));
  }
  const stubborn = classifyHolders(findPortPids(port), ownPids, signature)
    .filter((h) => h.ownership === "stray")
    .map((h) => h.pid);
  for (const pid of stubborn) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 200));
  const finalHeld = classifyHolders(findPortPids(port), ownPids, signature)
    .filter((h) => h.ownership === "stray")
    .map((h) => h.pid);
  return { killed: [...strays, ...stubborn], blocked, stillHeldBy: finalHeld };
}
