import { execFile } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const MIB = 1024 * 1024;

export type ProcessRow = {
  pid: number;
  ppid: number;
  pgid: number;
  rssBytes: number;
  command: string;
};

export type ResourceStatus = {
  timestampMs: number;
  pressure: "normal" | "soft" | "hard";
  busy: boolean;
  consecutiveHardSamples: number;
  limits: { softBytes: number; hardBytes: number; sustainedSamples: number };
  daemon: {
    pid: number;
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
  };
  managed: {
    rssBytes: number;
    processCount: number;
    byKindBytes: Record<string, number>;
    largest: { pid: number; rssBytes: number; command: string } | null;
  };
  action: string | null;
};

export type ResourceGovernorOptions = {
  softLimitBytes: number;
  hardLimitBytes: number;
  sustainedSamples: number;
  intervalMs: number;
  reliefCooldownMs?: number;
  restartOnHardLimit: boolean;
};

export type ResourceGovernorDeps = {
  collectProcesses: () => Promise<ProcessRow[]>;
  getWorkerPids: () => number[];
  isBusy: () => boolean;
  flushWorkers: () => Promise<number>;
  trimEmbeddings: () => number;
  collectMemory: () => { rss: number; heapUsed: number; external: number };
  gc: () => void;
  requestRestart: (reason: string) => void;
  writeStatus: (status: ResourceStatus) => void;
  now: () => number;
  log: (level: "info" | "warn" | "error", message: string) => void;
};

export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      command: match[5]!,
    });
  }
  return rows;
}

function processKind(command: string): string {
  const name = basename(command).toLowerCase();
  if (name === "bun") return "bun";
  if (name === "claude") return "claude";
  if (name === "node") return "node";
  if (name === "python" || name.startsWith("python")) return "python";
  if (name === "cloudflared") return "cloudflared";
  return "other";
}

/** Sum the daemon's descendant tree plus detached process groups rooted at its
 * resident Claude workers. This deliberately excludes unrelated Bun or Python
 * programs owned by the same login. */
export function summarizeManagedProcesses(
  rows: ProcessRow[],
  daemonPid: number,
  workerPids: number[],
): ResourceStatus["managed"] {
  const roots = new Set([daemonPid, ...workerPids]);
  const groups = new Set<number>();
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  for (const row of rows) {
    if (roots.has(row.pid)) groups.add(row.pgid);
  }
  const isDescendant = (pid: number): boolean => {
    let current = pid;
    for (let guard = 0; current > 1 && guard < 100; guard++) {
      if (roots.has(current)) return true;
      const parent = parents.get(current);
      if (!parent || parent === current) return false;
      current = parent;
    }
    return false;
  };
  const managed = rows.filter(
    (row) => roots.has(row.pid) || groups.has(row.pgid) || isDescendant(row.pid),
  );
  const byKindBytes: Record<string, number> = {};
  let rssBytes = 0;
  let largest: ResourceStatus["managed"]["largest"] = null;
  for (const row of managed) {
    rssBytes += row.rssBytes;
    const kind = processKind(row.command);
    byKindBytes[kind] = (byKindBytes[kind] ?? 0) + row.rssBytes;
    if (!largest || row.rssBytes > largest.rssBytes) {
      largest = { pid: row.pid, rssBytes: row.rssBytes, command: basename(row.command) };
    }
  }
  return { rssBytes, processCount: managed.length, byKindBytes, largest };
}

export function collectProcessTable(): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid=,rss=,comm="],
      { maxBuffer: 4 * MIB },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseProcessTable(stdout));
      },
    );
  });
}

export function atomicStatusWriter(path: string): (status: ResourceStatus) => void {
  return (status) => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(status)}\n`);
    renameSync(tmp, path);
  };
}

export class ResourceGovernor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private consecutiveHardSamples = 0;
  private lastReliefMs = 0;

  constructor(
    private readonly options: ResourceGovernorOptions,
    private readonly deps: ResourceGovernorDeps,
  ) {
    if (options.softLimitBytes >= options.hardLimitBytes) {
      throw new Error("resource governor soft limit must be below hard limit");
    }
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<ResourceStatus | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      const rows = await this.deps.collectProcesses();
      const mem = this.deps.collectMemory();
      const managed = summarizeManagedProcesses(rows, process.pid, this.deps.getWorkerPids());
      // ps and process.memoryUsage() take their snapshots at slightly different
      // moments. Never under-report the daemon if ps caught it between samples.
      managed.rssBytes = Math.max(managed.rssBytes, mem.rss);
      const overSoft = managed.rssBytes >= this.options.softLimitBytes;
      const overHard =
        managed.rssBytes >= this.options.hardLimitBytes || mem.rss >= this.options.hardLimitBytes;
      this.consecutiveHardSamples = overHard ? this.consecutiveHardSamples + 1 : 0;

      const busy = this.deps.isBusy();
      let action: string | null = null;
      const now = this.deps.now();
      const cooldown = this.options.reliefCooldownMs ?? 5 * 60_000;
      if (overSoft && now - this.lastReliefMs >= cooldown) {
        const embeddings = this.deps.trimEmbeddings();
        const workers = busy ? 0 : await this.deps.flushWorkers();
        this.deps.gc();
        this.lastReliefMs = now;
        action = busy
          ? `trimmed ${embeddings} embedding worker(s); resident workers busy`
          : `trimmed ${embeddings} embedding worker(s), evicted ${workers} idle worker(s), forced GC`;
        this.deps.log("warn", `[resources] soft memory limit: ${action}`);
        // Give successful cleanup a full sustained window to show up in ps
        // before deciding that the daemon itself needs a graceful restart.
        if (embeddings > 0 || workers > 0) this.consecutiveHardSamples = 0;
      }

      let restartReason: string | null = null;
      if (
        overHard &&
        this.consecutiveHardSamples >= this.options.sustainedSamples &&
        this.options.restartOnHardLimit
      ) {
        if (busy) {
          action = "hard limit restart deferred until active turns finish";
          this.deps.log("error", `[resources] ${action}`);
        } else {
          restartReason =
            `managed RSS remained at ${Math.round(managed.rssBytes / MIB)} MiB ` +
            `for ${this.consecutiveHardSamples} samples`;
          action = `graceful restart requested: ${restartReason}`;
        }
      }

      const status: ResourceStatus = {
        timestampMs: now,
        pressure: overHard ? "hard" : overSoft ? "soft" : "normal",
        busy,
        consecutiveHardSamples: this.consecutiveHardSamples,
        limits: {
          softBytes: this.options.softLimitBytes,
          hardBytes: this.options.hardLimitBytes,
          sustainedSamples: this.options.sustainedSamples,
        },
        daemon: {
          pid: process.pid,
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          externalBytes: mem.external,
        },
        managed,
        action,
      };
      this.deps.writeStatus(status);
      if (restartReason) {
        this.deps.log("error", `[resources] ${action}`);
        this.deps.requestRestart(restartReason);
      }
      return status;
    } catch (error) {
      this.deps.log(
        "warn",
        `[resources] sample failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}
