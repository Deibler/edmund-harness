import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../util/log.ts";

/**
 * A turn worker answers to one daemon and must not outlive it.
 *
 * A turn worker is spawned in its own process group, so that stopping it stops
 * its whole tree. The same thing lets it outlive the daemon: when the daemon
 * dies the worker carries on, finishes its turn and delivers it, while the next
 * daemon replays the same messages to a new worker. On 2026-11-24 a daemon that
 * died 44 times in 26 minutes sent one person 17 messages for 2 requests.
 *
 * So each turn worker is written down beside the daemon that owns it. A
 * watchdog started by the daemon stops them when it is gone, and the next
 * daemon stops whatever is still written down before it serves a send or
 * replays a message.
 *
 * Only turn workers. Sub-agents and background jobs are detached on purpose,
 * are kept in their own stores, and are meant to survive a restart.
 */

export type TurnWorkerEntry = {
  pid: number;
  /** Wall clock at spawn. With the pid, it says which process this was. */
  spawnedMs: number;
  owner: number;
  ownerStartedMs: number;
  /** For the log: the session the worker was serving. */
  label: string;
};

type RunningProcess = { pgid: number; startedMs: number };

/** `ps` reports elapsed time in whole seconds, and a spawn is not instant. */
const START_TOLERANCE_MS = 10_000;
const GRACE_MS = 1_500;

/** Not an entry: entries end in `.json`. */
const LAST_STOP = "last-stop";

export const WATCHDOG_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "turn-worker-watchdog.ts",
);

/** Set by the daemon at boot. Unset, nothing is written down: a test or a
 *  script that runs a worker stays responsible for it itself. */
let ledger: string | null = null;

/**
 * The daemon's first act on workers: stop the ones a previous daemon left
 * running, then start writing its own down under a watchdog.
 */
export async function guardTurnWorkers(dataDir: string): Promise<TurnWorkerEntry[]> {
  const dir = join(resolve(dataDir), "run", "turn-workers");
  let stopped: TurnWorkerEntry[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    reportLastStop(dir);
    stopped = await reapTurnWorkers(dir);
  } catch (err) {
    // A daemon that boots unguarded is better than one that does not boot.
    log.error("turn-workers", "could not look for workers a previous daemon left", {
      err: (err as Error).message,
    });
  }
  if (stopped.length > 0) {
    log.warn("turn-workers", "stopped workers a previous daemon left running", {
      count: stopped.length,
      sessions: stopped.map((entry) => entry.label),
    });
  }
  ledger = dir;
  startWatchdog(dir);
  return stopped;
}

/**
 * What the watchdog calls when its daemon is gone. It has no log of its own,
 * so it leaves a note of what it stopped for the next daemon to report.
 */
export async function stopWorkersOf(dir: string, owner: number): Promise<TurnWorkerEntry[]> {
  const stopped = await reapTurnWorkers(dir, { owner });
  if (stopped.length > 0) {
    const note = { atMs: Date.now(), owner, sessions: stopped.map((entry) => entry.label) };
    writeFileSync(join(dir, LAST_STOP), JSON.stringify(note));
  }
  return stopped;
}

function reportLastStop(dir: string): void {
  const path = join(dir, LAST_STOP);
  let note: { atMs?: number; owner?: number; sessions?: string[] };
  try {
    note = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
  rmSync(path, { force: true });
  log.warn(
    "turn-workers",
    "the last daemon went down with workers still running; they were stopped",
    {
      at: new Date(note.atMs ?? 0).toISOString(),
      daemon: note.owner,
      sessions: note.sessions,
    },
  );
}

/** Writes a turn worker down until it exits. Call it where the worker is spawned. */
export function trackTurnWorker(proc: Pick<ChildProcess, "pid" | "once">, label: string): void {
  const dir = ledger;
  const pid = proc.pid;
  if (!dir || !pid) return;
  const entry: TurnWorkerEntry = {
    pid,
    spawnedMs: Date.now(),
    owner: process.pid,
    ownerStartedMs: Date.now() - process.uptime() * 1000,
    label,
  };
  try {
    writeFileSync(entryPath(dir, pid), JSON.stringify(entry));
    proc.once("exit", () => forget(dir, pid));
  } catch (err) {
    // The worker still runs. It is only unguarded, which is worth knowing.
    log.error("turn-workers", "could not write a worker down", {
      session: label,
      err: (err as Error).message,
    });
  }
}

/**
 * Stops every written-down worker whose daemon is gone, and returns them.
 *
 * `owner` names a daemon the caller knows is gone; any other owner is gone
 * when no process with its pid and start time is running. A worker is only
 * touched while its pid still leads a process group that began when the worker
 * did, so a pid the system has handed to something else is left alone.
 */
export async function reapTurnWorkers(
  dir: string,
  opts: { owner?: number; graceMs?: number } = {},
): Promise<TurnWorkerEntry[]> {
  const entries = readEntries(dir);
  if (entries.length === 0) return [];
  const running = runningProcesses(entries.flatMap((entry) => [entry.pid, entry.owner]));

  const orphans: TurnWorkerEntry[] = [];
  for (const entry of entries) {
    const worker = running.get(entry.pid);
    const stillTheWorker =
      worker !== undefined && worker.pgid === entry.pid && near(worker.startedMs, entry.spawnedMs);
    if (!stillTheWorker) {
      forget(dir, entry.pid);
      continue;
    }
    const owner = running.get(entry.owner);
    const ownerAlive =
      entry.owner !== opts.owner &&
      owner !== undefined &&
      near(owner.startedMs, entry.ownerStartedMs);
    if (!ownerAlive) orphans.push(entry);
  }

  for (const entry of orphans) signalGroup(entry.pid, "SIGTERM");
  const deadline = Date.now() + (opts.graceMs ?? GRACE_MS);
  while (Date.now() < deadline && orphans.some((entry) => groupAlive(entry.pid))) {
    await new Promise((done) => setTimeout(done, 50));
  }
  for (const entry of orphans) {
    if (groupAlive(entry.pid)) signalGroup(entry.pid, "SIGKILL");
    forget(dir, entry.pid);
  }
  return orphans;
}

function startWatchdog(dir: string, retryMs = 1_000): void {
  const startedAt = Date.now();
  let handled = false;
  const restart = (why: string) => {
    if (handled) return;
    handled = true;
    // Until it is back, workers that survive a crash wait for the next boot.
    log.error("turn-workers", "watchdog is not running; starting it again", { why, retryMs });
    const next = Date.now() - startedAt > 60_000 ? 1_000 : Math.min(retryMs * 2, 60_000);
    setTimeout(() => startWatchdog(dir, next), retryMs).unref();
  };
  // This runs again from a timer, where a throw would end the daemon.
  try {
    const child = spawn(process.execPath, [WATCHDOG_SCRIPT, dir, String(process.pid)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    child.once("error", (err) => restart(err.message));
    child.once("exit", (code, signal) => restart(`exited code=${code} signal=${signal}`));
  } catch (err) {
    restart((err as Error).message);
  }
}

function entryPath(dir: string, pid: number): string {
  return join(dir, `${pid}.json`);
}

/** Called from a worker's exit event, so it must not throw. */
function forget(dir: string, pid: number): void {
  try {
    rmSync(entryPath(dir, pid), { force: true });
  } catch (err) {
    log.error("turn-workers", "could not forget a worker", { pid, err: (err as Error).message });
  }
}

function readEntries(dir: string): TurnWorkerEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: TurnWorkerEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as TurnWorkerEntry;
      const whole = [entry.pid, entry.spawnedMs, entry.owner, entry.ownerStartedMs].every(
        (value) => Number.isFinite(value) && value > 1,
      );
      if (whole && name === `${entry.pid}.json`) {
        entries.push({ ...entry, label: String(entry.label ?? "") });
        continue;
      }
    } catch {
      // A half-written entry names nothing that can be acted on.
    }
    rmSync(path, { force: true });
  }
  return entries;
}

/** The given pids that are running now, with their group and start time. */
function runningProcesses(pids: number[]): Map<number, RunningProcess> {
  const found = new Map<number, RunningProcess>();
  const wanted = [...new Set(pids)];
  if (wanted.length === 0) return found;
  const now = Date.now();
  const ps = spawnSync("ps", ["-o", "pid=,pgid=,etime=", "-p", wanted.join(",")], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  for (const line of (ps.stdout ?? "").split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!match) continue;
    const [, pid, pgid, days, hours, minutes, seconds] = match;
    const elapsed =
      ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
    found.set(Number(pid), { pgid: Number(pgid), startedMs: now - elapsed * 1000 });
  }
  return found;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= START_TOLERANCE_MS;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group emptied on its own.
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
