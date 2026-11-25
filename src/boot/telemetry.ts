/**
 * The machine and the process tree, written down once a minute.
 *
 * The resource governor acts on memory and says so when it acts. What it saw
 * the rest of the time was nowhere: `resource-status.json` holds one sample,
 * the latest. So "what was using the memory at 02:13" and "was the GPU busy
 * when the call stuttered" had no answer after the fact.
 *
 * Each sample is one `resource` record: the daemon, its whole process tree by
 * kind, the largest and busiest processes, and the machine (memory pressure,
 * swap, load, CPU, GPU, disk, thermal limit). The tree is compared with the
 * last sample and each process that appeared or went is one `proc` record.
 * That is the system's own account of what ran, and it covers what no spawn
 * site can: a worker's own children, and a process still there after its
 * parent stopped caring.
 *
 * Everything here is read without privileges and takes about 25 ms a command
 * (measured 2026-11-25 on macOS 26, Apple M4). On another system the commands
 * are missing and their fields are left out.
 */
import { statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { basename } from "node:path";
import { isMeasuringProcess, withoutProcessLog } from "../util/log-instrument.ts";
import { log } from "../util/log.ts";
import { managedProcesses, processKind } from "./resource-governor.ts";

const MIB = 1024 * 1024;

export type SampledProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  rssBytes: number;
  cpuPercent: number;
  elapsed: string;
  command: string;
};

/** `ps -axo pid=,ppid=,pgid=,rss=,pcpu=,etime=,comm=` */
export function parseSampledProcesses(output: string): SampledProcess[] {
  const rows: SampledProcess[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      rssBytes: Number(m[4]) * 1024,
      cpuPercent: Number(m[5]),
      elapsed: m[6]!,
      command: m[7]!,
    });
  }
  return rows;
}

/** `sysctl -n kern.memorystatus_vm_pressure_level vm.swapusage` */
export function parseMemoryState(output: string): { pressure?: string; swapUsedMb?: number } {
  const out: { pressure?: string; swapUsedMb?: number } = {};
  const level = output.match(/^\s*([124])\s*$/m)?.[1];
  if (level) out.pressure = level === "1" ? "normal" : level === "2" ? "warn" : "critical";
  const swap = output.match(/used = ([\d.]+)M/);
  if (swap) out.swapUsedMb = Math.round(Number(swap[1]));
  return out;
}

/** `ioreg -r -d 1 -w 0 -c IOAccelerator`: the GPU's own utilisation counters. */
export function parseGpuState(output: string): { gpuPercent?: number; gpuMemMb?: number } {
  const out: { gpuPercent?: number; gpuMemMb?: number } = {};
  const busy = output.match(/"Device Utilization %"=(\d+)/);
  if (busy) out.gpuPercent = Number(busy[1]);
  const mem = output.match(/"In use system memory"=(\d+)/);
  if (mem) out.gpuMemMb = Math.round(Number(mem[1]) / MIB);
  return out;
}

/** `pmset -g therm`: present only while the system is holding the CPU back. */
export function parseThermalState(output: string): { cpuSpeedLimit?: number } {
  const limit = output.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  return limit ? { cpuSpeedLimit: Number(limit[1]) } : {};
}

/** The commands a sample is running right now, which are not part of what it measures. */
const sampling = new Set<number>();

/** Run a measuring command and return what it printed; empty when it is missing or fails. */
export async function quietRead(command: string[]): Promise<string> {
  let pid = 0;
  try {
    const proc = withoutProcessLog(() =>
      Bun.spawn(command, { stdout: "pipe", stderr: "ignore", stdin: "ignore" }),
    );
    pid = proc.pid;
    sampling.add(pid);
    const text = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? text : "";
  } catch {
    return "";
  } finally {
    // Kept until the sample that started it has read the table it may be in.
    if (pid) setTimeout(() => sampling.delete(pid), 5_000).unref?.();
  }
}

type CpuTimes = { idle: number; total: number };
function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

export type TelemetryOptions = {
  dataDir: string;
  intervalMs: number;
  daemonPid?: number;
  getWorkerPids: () => number[];
  /** For tests: the process table and the machine readings. */
  readProcesses?: () => Promise<SampledProcess[]>;
  readMachine?: () => Promise<Record<string, unknown>>;
};

/** What changed in the tree between two samples. */
export function diffTree(
  before: Map<number, SampledProcess>,
  after: SampledProcess[],
): { appeared: SampledProcess[]; gone: SampledProcess[] } {
  const now = new Set(after.map((p) => p.pid));
  return {
    appeared: after.filter((p) => !before.has(p.pid)),
    gone: [...before.values()].filter((p) => !now.has(p.pid)),
  };
}

export class Telemetry {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tree = new Map<number, SampledProcess>();
  private peak = new Map<number, number>();
  private firstSample = true;
  private lastCpu: CpuTimes | null = null;
  private sampling = false;

  constructor(private readonly opts: TelemetryOptions) {}

  start(): void {
    if (this.timer || this.opts.intervalMs <= 0) return;
    this.lastCpu = cpuTimes();
    this.timer = setInterval(() => void this.sample(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private readProcesses(): Promise<SampledProcess[]> {
    return (
      this.opts.readProcesses?.() ??
      quietRead(["/bin/ps", "-axo", "pid=,ppid=,pgid=,rss=,pcpu=,etime=,comm="]).then(
        parseSampledProcesses,
      )
    );
  }

  private async readMachine(): Promise<Record<string, unknown>> {
    if (this.opts.readMachine) return this.opts.readMachine();
    const [memory, gpu, thermal] = await Promise.all([
      quietRead(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level", "vm.swapusage"]),
      quietRead(["/usr/sbin/ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]),
      quietRead(["/usr/bin/pmset", "-g", "therm"]),
    ]);
    const m = parseMemoryState(memory);
    const g = parseGpuState(gpu);
    const t = parseThermalState(thermal);
    let diskFreeGb: number | undefined;
    try {
      const fs = statfsSync(this.opts.dataDir);
      diskFreeGb = Math.round((fs.bavail * fs.bsize) / (1024 * MIB));
    } catch {}
    const cpu = cpuTimes();
    let cpuPercent: number | undefined;
    if (this.lastCpu && cpu.total > this.lastCpu.total) {
      cpuPercent = Math.round(
        100 * (1 - (cpu.idle - this.lastCpu.idle) / (cpu.total - this.lastCpu.total)),
      );
    }
    this.lastCpu = cpu;
    return {
      mem_total_mb: Math.round(totalmem() / MIB),
      mem_free_mb: Math.round(freemem() / MIB),
      ...(m.pressure ? { mem_pressure: m.pressure } : {}),
      ...(m.swapUsedMb !== undefined ? { swap_used_mb: m.swapUsedMb } : {}),
      load1: Math.round(loadavg()[0]! * 100) / 100,
      ...(cpuPercent !== undefined ? { cpu_pct: cpuPercent } : {}),
      ...(g.gpuPercent !== undefined ? { gpu_pct: g.gpuPercent } : {}),
      ...(g.gpuMemMb !== undefined ? { gpu_mem_mb: g.gpuMemMb } : {}),
      ...(t.cpuSpeedLimit !== undefined ? { cpu_speed_limit: t.cpuSpeedLimit } : {}),
      ...(diskFreeGb !== undefined ? { disk_free_gb: diskFreeGb } : {}),
    };
  }

  /** One sample. Public so a test, and a boot that wants a first reading, can take one. */
  async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const [rows, machine] = await Promise.all([this.readProcesses(), this.readMachine()]);
      const daemonPid = this.opts.daemonPid ?? process.pid;
      const managed = managedProcesses(rows, daemonPid, this.opts.getWorkerPids()).filter(
        (p) => !sampling.has(p.pid) && !isMeasuringProcess(p.pid),
      );
      const describe = (p: SampledProcess) => ({
        pid: p.pid,
        cmd: basename(p.command),
        mb: Math.round(p.rssBytes / MIB),
        cpu: p.cpuPercent,
      });

      const byKind: Record<string, number> = {};
      let total = 0;
      for (const p of managed) {
        total += p.rssBytes;
        const kind = processKind(p.command);
        byKind[kind] = (byKind[kind] ?? 0) + Math.round(p.rssBytes / MIB);
        this.peak.set(p.pid, Math.max(this.peak.get(p.pid) ?? 0, p.rssBytes));
      }
      const memory = process.memoryUsage();
      const largest = [...managed].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 5);
      const busiest = managed
        .filter((p) => p.cpuPercent >= 10)
        .sort((a, b) => b.cpuPercent - a.cpuPercent)
        .slice(0, 3);
      log.event(
        "resource",
        "sample",
        `sample tree=${Math.round(total / MIB)}MB procs=${managed.length} load=${machine.load1 ?? "?"} cpu=${machine.cpu_pct ?? "?"}% gpu=${machine.gpu_pct ?? "?"}% pressure=${machine.mem_pressure ?? "?"} disk=${machine.disk_free_gb ?? "?"}GB`,
        {
          daemon_rss_mb: Math.round(memory.rss / MIB),
          daemon_heap_mb: Math.round(memory.heapUsed / MIB),
          tree_mb: Math.round(total / MIB),
          tree_procs: managed.length,
          by_kind_mb: byKind,
          largest: largest.map(describe),
          ...(busiest.length > 0 ? { busiest: busiest.map(describe) } : {}),
          ...machine,
        },
        machine.mem_pressure === "critical" ? "warn" : "info",
      );

      const { appeared, gone } = diffTree(this.tree, managed);
      if (this.firstSample) {
        log.event("proc", "tree", `tree at first sample: ${managed.length} processes`, {
          processes: managed.map((p) => ({ ...describe(p), ppid: p.ppid, up: p.elapsed })),
        });
      } else {
        for (const p of appeared) {
          log.event("proc", "tree", `appeared ${basename(p.command)}`, {
            ...describe(p),
            ppid: p.ppid,
            kind: processKind(p.command),
            up: p.elapsed,
          });
        }
        for (const p of gone) {
          log.event("proc", "tree", `gone ${basename(p.command)}`, {
            pid: p.pid,
            cmd: basename(p.command),
            ppid: p.ppid,
            last_up: p.elapsed,
            peak_mb: Math.round((this.peak.get(p.pid) ?? p.rssBytes) / MIB),
          });
          this.peak.delete(p.pid);
        }
      }
      this.firstSample = false;
      this.tree = new Map(managed.map((p) => [p.pid, p]));
    } catch (err) {
      log.event("resource", "sample", "sample failed", { err: (err as Error).message }, "warn");
    } finally {
      this.sampling = false;
    }
  }
}
