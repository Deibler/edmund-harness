/**
 * Lockdown: one switch that closes what faces outward and takes the model's
 * hands off the machine, and one that puts it back.
 *
 * On:
 *  - every quick tunnel is taken down, and with it every shared artifact
 *    (`trycloudflare.com` links). A tunnel launchd keeps alive is unloaded,
 *    not just killed, or it would be back in ten seconds.
 *  - workers lose the shell and the filesystem: `hostAccess` answers
 *    "sandboxed" while the flag is set (security/policy.ts), and the warm
 *    pool is emptied so the next turn starts that way.
 *  - nobody but the operator is messaged, and the web tools are refused
 *    (watch/service.ts reads the same flag on every tool call and reply).
 *
 * Left up on purpose: the named tunnels. The kitchen's pages and the SMS
 * webhook are how the household and the operator still reach the assistant.
 *
 * Everything it does is written into the flag as a step to reverse, so
 * `off` restores exactly what `on` took down and nothing else.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTunnels } from "../security/watch/exposure.ts";
import { type Lockdown, readWatchState, updateWatchState } from "../security/watch/state.ts";
import { log } from "../util/log.ts";

export type Shell = (argv: string[]) => { ok: boolean; out: string };

export const runShell: Shell = (argv) => {
  try {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    return { ok: r.exitCode === 0, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
  } catch (err) {
    return { ok: false, out: (err as Error).message };
  }
};

export type LockdownDeps = {
  dataDir: string;
  repoRoot: string;
  shell?: Shell;
  /** Empty the warm worker pool so the next turn starts under the new host access. */
  flushWorkers?: () => Promise<void> | void;
  uid?: number;
  now?: () => number;
};

/** The launchd label that owns a pid, when one does. */
function launchdLabelOf(pid: number, shell: Shell): string | null {
  const listing = shell(["launchctl", "list"]).out;
  for (const line of listing.split("\n")) {
    const [p, , label] = line.trim().split(/\s+/);
    if (Number(p) === pid && label) return label;
  }
  return null;
}

/** Take down every quick tunnel. Returns what was closed and how each comes back. */
function closeQuickTunnels(deps: LockdownDeps): Lockdown["restore"] {
  const shell = deps.shell ?? runShell;
  const uid = deps.uid ?? process.getuid?.() ?? 501;
  const restore: Lockdown["restore"] = [];
  const tunnels = parseTunnels(shell(["ps", "-axo", "pid=,command="]).out).filter(
    (t) => t.kind === "quick",
  );
  for (const tunnel of tunnels) {
    const label = launchdLabelOf(tunnel.pid, shell);
    if (label) {
      const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
      const out = shell(["launchctl", "bootout", `gui/${uid}/${label}`]);
      restore.push({
        kind: "tunnel",
        detail: `quick tunnel to ${tunnel.target} (${label})${out.ok ? "" : ": could not unload"}`,
        ...(existsSync(plist) ? { command: `launchctl bootstrap gui/${uid} ${plist}` } : {}),
      });
    } else {
      const out = shell(["kill", String(tunnel.pid)]);
      restore.push({
        kind: "tunnel",
        detail: `quick tunnel to ${tunnel.target} (pid ${tunnel.pid})${out.ok ? "" : ": could not stop"}`,
      });
    }
  }
  return restore;
}

/** Stop every shared artifact with the skill's own reaper, which knows which processes are its. */
function stopShares(deps: LockdownDeps): Lockdown["restore"] {
  const shell = deps.shell ?? runShell;
  const reaper = join(deps.repoRoot, "skills", "instant-share", "scripts", "reap.py");
  if (!existsSync(reaper)) return [];
  const out = shell([
    "python3",
    reaper,
    "--config-dir",
    join(deps.dataDir, "instant-share"),
    "--all",
    "--json",
  ]);
  let stopped = 0;
  try {
    const parsed = JSON.parse(out.out) as { reaped?: unknown[]; stopped?: unknown[] };
    stopped = (parsed.reaped ?? parsed.stopped ?? []).length;
  } catch {}
  return stopped > 0 || !out.ok
    ? [
        {
          kind: "shares",
          detail: out.ok ? `${stopped} shared artifacts stopped` : "could not run the share reaper",
        },
      ]
    : [];
}

export type LockdownResult = { on: boolean; changed: boolean; did: string[] };

/** Lock the machine down. Doing it twice changes nothing the second time. */
export async function lockdownOn(deps: LockdownDeps, by: string): Promise<LockdownResult> {
  if (readWatchState(deps.dataDir).lockdown) {
    return { on: true, changed: false, did: ["already locked down"] };
  }
  const now = (deps.now ?? Date.now)();
  // The flag first: from this instant no worker is started with a shell and
  // no message leaves, whatever else below fails.
  updateWatchState(deps.dataDir, (s) => {
    s.lockdown = { since: now, by, restore: [] };
  });
  const restore = [...stopShares(deps), ...closeQuickTunnels(deps)];
  updateWatchState(deps.dataDir, (s) => {
    if (s.lockdown) s.lockdown.restore = restore;
  });
  await deps.flushWorkers?.();
  const did = [
    ...restore.map((r) => r.detail),
    "workers have no shell or filesystem",
    "only the operator is messaged",
    "web tools are off",
  ];
  log.event("security", "lockdown", `lockdown on, by ${by}`, { did }, "error");
  return { on: true, changed: true, did };
}

/** Lift the lockdown and bring back what it unloaded. */
export async function lockdownOff(deps: LockdownDeps, by: string): Promise<LockdownResult> {
  const current = readWatchState(deps.dataDir).lockdown;
  if (!current) return { on: false, changed: false, did: ["was not locked down"] };
  const shell = deps.shell ?? runShell;
  const did: string[] = [];
  for (const step of current.restore) {
    if (!step.command) {
      did.push(`not restarted: ${step.detail}`);
      continue;
    }
    const out = shell(step.command.split(" "));
    did.push(`${out.ok ? "restarted" : "could not restart"}: ${step.detail}`);
  }
  updateWatchState(deps.dataDir, (s) => {
    s.lockdown = null;
  });
  await deps.flushWorkers?.();
  did.push("workers have their usual access", "messages and web tools are back");
  log.event("security", "lockdown", `lockdown off, by ${by}`, { did }, "warn");
  return { on: false, changed: true, did };
}
