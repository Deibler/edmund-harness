/**
 * The once-a-minute sample: what the machine and the process tree looked
 * like, kept so the question can be asked afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SampledProcess,
  Telemetry,
  diffTree,
  parseGpuState,
  parseMemoryState,
  parseSampledProcesses,
  parseThermalState,
} from "../src/boot/telemetry.ts";
import { readChannel } from "../src/util/log-files.ts";
import { installLogSink, uninstallLogSink } from "../src/util/log-sink.ts";

describe("reading the system's own counters", () => {
  // As printed on macOS 26, Apple M4, 2026-11-25.
  test("ps", () => {
    const rows = parseSampledProcesses(
      [
        "  501     1   501  812544   3.2 02-11:04:55 /opt/homebrew/bin/bun",
        "  777   501   777 1048576  98.5    00:41.12 /Users/x/.local/bin/claude",
        "garbage",
      ].join("\n"),
    );
    expect(rows).toEqual([
      {
        pid: 501,
        ppid: 1,
        pgid: 501,
        rssBytes: 812544 * 1024,
        cpuPercent: 3.2,
        elapsed: "02-11:04:55",
        command: "/opt/homebrew/bin/bun",
      },
      {
        pid: 777,
        ppid: 501,
        pgid: 777,
        rssBytes: 1048576 * 1024,
        cpuPercent: 98.5,
        elapsed: "00:41.12",
        command: "/Users/x/.local/bin/claude",
      },
    ]);
  });

  test("memory pressure and swap", () => {
    expect(
      parseMemoryState("1\ntotal = 5120.00M  used = 4074.00M  free = 1046.00M  (encrypted)\n"),
    ).toEqual({ pressure: "normal", swapUsedMb: 4074 });
    expect(parseMemoryState("4\n").pressure).toBe("critical");
    expect(parseMemoryState("")).toEqual({});
  });

  test("GPU", () => {
    const line =
      '"PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=3840032768,"Tiler Utilization %"=12,"Renderer Utilization %"=12,"Device Utilization %"=46,"In use system memory"=414892032}';
    expect(parseGpuState(line)).toEqual({ gpuPercent: 46, gpuMemMb: 396 });
    expect(parseGpuState("")).toEqual({});
  });

  test("thermal limit, present only while the CPU is held back", () => {
    expect(parseThermalState("Note: No thermal warning level has been recorded\n")).toEqual({});
    expect(parseThermalState("CPU_Scheduler_Limit \t= 100\nCPU_Speed_Limit \t= 72\n")).toEqual({
      cpuSpeedLimit: 72,
    });
  });
});

const proc = (pid: number, ppid: number, mb: number, command: string, cpu = 0): SampledProcess => ({
  pid,
  ppid,
  pgid: pid,
  rssBytes: mb * 1024 * 1024,
  cpuPercent: cpu,
  elapsed: "00:10",
  command,
});

describe("the sample", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "telemetry-"));
    installLogSink(dir, "", "daemon.log", { echo: false, instrument: false });
  });
  afterEach(() => {
    uninstallLogSink();
    rmSync(dir, { recursive: true, force: true });
  });

  test("records the tree, the largest and busiest, and the machine; then what appeared and went", async () => {
    let table: SampledProcess[] = [
      proc(100, 1, 900, "/opt/homebrew/bin/bun"),
      proc(200, 100, 1500, "/Users/x/.local/bin/claude", 85),
      proc(300, 200, 40, "/bin/zsh"),
      proc(999, 1, 5000, "/Applications/Unrelated.app/Contents/MacOS/Unrelated", 99),
    ];
    const telemetry = new Telemetry({
      dataDir: dir,
      intervalMs: 60_000,
      daemonPid: 100,
      getWorkerPids: () => [200],
      readProcesses: async () => table,
      readMachine: async () => ({
        load1: 2.5,
        cpu_pct: 31,
        gpu_pct: 46,
        mem_pressure: "warn",
        disk_free_gb: 24,
      }),
    });
    await telemetry.sample();

    const [sample] = readChannel(dir, "resource", 0);
    expect(sample!.msg).toBe(
      "sample tree=2440MB procs=3 load=2.5 cpu=31% gpu=46% pressure=warn disk=24GB",
    );
    expect(sample!.fields).toMatchObject({
      tree_mb: 2440,
      tree_procs: 3,
      by_kind_mb: { bun: 900, claude: 1500, other: 40 },
      gpu_pct: 46,
      busiest: [{ pid: 200, cmd: "claude", cpu: 85 }],
    });
    // Another program owned by the same login is not the harness's tree.
    expect((sample!.fields!.largest as { pid: number }[]).map((p) => p.pid)).toEqual([
      200, 100, 300,
    ]);
    expect(readChannel(dir, "proc", 0).map((r) => r.msg)).toEqual([
      "tree at first sample: 3 processes",
    ]);

    table = [proc(100, 1, 950, "/opt/homebrew/bin/bun"), proc(400, 100, 60, "/usr/bin/python3")];
    await telemetry.sample();
    const changes = readChannel(dir, "proc", 0).slice(1);
    expect(changes.map((r) => r.msg)).toEqual(["appeared python3", "gone claude", "gone zsh"]);
    expect(changes[1]!.fields).toMatchObject({ pid: 200, peak_mb: 1500 });
    // Nothing a sample writes belongs in the operational log.
    expect(Bun.file(join(dir, "daemon.log")).size).toBe(0);
  });

  test("critical memory pressure is a warning", async () => {
    const telemetry = new Telemetry({
      dataDir: dir,
      intervalMs: 60_000,
      daemonPid: 100,
      getWorkerPids: () => [],
      readProcesses: async () => [proc(100, 1, 900, "/opt/homebrew/bin/bun")],
      readMachine: async () => ({ mem_pressure: "critical" }),
    });
    await telemetry.sample();
    expect(readChannel(dir, "error", 0)).toHaveLength(1);
  });

  test("the commands that take the sample are not in the tree it records", async () => {
    // For real: `ps` is this process's child at the moment it lists this process's children.
    const telemetry = new Telemetry({ dataDir: dir, intervalMs: 60_000, getWorkerPids: () => [] });
    await telemetry.sample();
    const [first] = readChannel(dir, "proc", 0);
    const names = (first!.fields!.processes as { cmd: string; pid: number }[]).map((p) => p.cmd);
    expect(names.length).toBeGreaterThan(0);
    for (const tool of ["ps", "sysctl", "(sysctl)", "ioreg", "pmset"]) {
      expect(names).not.toContain(tool);
    }
  });

  test("the tree's changes are the pids that differ", () => {
    const before = new Map([
      [1, proc(1, 0, 1, "a")],
      [2, proc(2, 1, 1, "b")],
    ]);
    const { appeared, gone } = diffTree(before, [proc(2, 1, 1, "b"), proc(3, 1, 1, "c")]);
    expect(appeared.map((p) => p.pid)).toEqual([3]);
    expect(gone.map((p) => p.pid)).toEqual([1]);
  });
});
