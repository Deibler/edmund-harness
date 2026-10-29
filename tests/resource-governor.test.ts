import { describe, expect, test } from "bun:test";
import {
  ResourceGovernor,
  type ResourceGovernorDeps,
  type ResourceStatus,
  makeFootprintReader,
  parseProcessTable,
  summarizeManagedProcesses,
} from "../src/boot/resource-governor.ts";

const MIB = 1024 * 1024;

describe("resource governor process accounting", () => {
  test("parses ps rows and includes daemon and detached worker process groups", () => {
    const rows = parseProcessTable(`
      ${process.pid} 1 700 1024 /opt/homebrew/bin/bun
      20 ${process.pid} 700 512 /usr/bin/helper
      30 ${process.pid} 30 2048 /opt/homebrew/bin/claude
      31 30 30 4096 /opt/homebrew/bin/node
      90 1 90 9999 /opt/homebrew/bin/python3
    `);
    const summary = summarizeManagedProcesses(rows, process.pid, []);
    expect(summary.processCount).toBe(4);
    expect(summary.rssBytes).toBe((1024 + 512 + 2048 + 4096) * 1024);
    expect(summary.byKindBytes.python).toBeUndefined();
    expect(summary.byKindBytes.claude).toBe(2048 * 1024);
    expect(summary.largest?.pid).toBe(31);
  });
});

function harness(args?: {
  busy?: boolean;
  rssMiB?: number;
  footprintMiB?: number;
  trim?: number;
  /** Sessions the pool would evict, least recently used first. */
  idle?: string[];
}) {
  let now = 1_000_000_000;
  let evictions = 0;
  const idle = [...(args?.idle ?? [])];
  let trims = 0;
  let restarts = 0;
  let lastStatus: ResourceStatus | null = null;
  const rss = (args?.rssMiB ?? 5) * MIB;
  const footprint = args?.footprintMiB === undefined ? null : args.footprintMiB * MIB;
  const deps: ResourceGovernorDeps = {
    collectProcesses: async () => [
      {
        pid: process.pid,
        ppid: 1,
        pgid: process.pid,
        rssBytes: rss,
        footprintBytes: footprint,
        command: "bun",
      },
    ],
    getWorkerPids: () => [],
    isBusy: () => args?.busy ?? false,
    evictIdleWorker: async () => {
      evictions++;
      return idle.shift() ?? null;
    },
    trimEmbeddings: () => {
      trims++;
      return args?.trim ?? 0;
    },
    collectMemory: () => ({ rss, heapUsed: MIB, external: MIB, footprint }),
    gc: () => {},
    requestRestart: () => {
      restarts++;
    },
    writeStatus: (status) => {
      lastStatus = status;
    },
    now: () => now,
    log: () => {},
  };
  const governor = new ResourceGovernor(
    {
      softLimitBytes: 4 * MIB,
      hardLimitBytes: 8 * MIB,
      sustainedSamples: 3,
      intervalMs: 10_000,
      reliefCooldownMs: 60_000,
      restartOnHardLimit: true,
    },
    deps,
  );
  return {
    governor,
    advance: () => {
      now += 10_000;
    },
    counts: () => ({ evictions, trims, restarts }),
    status: () => lastStatus,
  };
}

describe("resource governor actions", () => {
  test("soft pressure trims embeddings and evicts one idle worker, not all of them", async () => {
    const h = harness({ trim: 1, idle: ["dm:a", "dm:b"] });
    const status = await h.governor.tick();
    expect(status?.pressure).toBe("soft");
    expect(h.counts()).toEqual({ evictions: 1, trims: 1, restarts: 0 });
    expect(h.status()?.action).toContain("evicted idle worker dm:a (least recently used)");
  });

  test("each sample evicts the next least recently used, until none qualifies", async () => {
    const h = harness({ idle: ["dm:a", "dm:b"] });
    const seen: (string | null | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      await h.governor.tick();
      seen.push(h.status()?.action);
      h.advance();
    }
    expect(seen[0]).toContain("dm:a");
    expect(seen[1]).toContain("dm:b");
    expect(seen[2]).toBeNull();
    // Embeddings are trimmed once per cooldown, not every sample.
    expect(h.counts().trims).toBe(1);
  });

  test("one busy session does not stop relief for the idle ones", async () => {
    const h = harness({ busy: true, idle: ["dm:idle"] });
    await h.governor.tick();
    expect(h.status()?.action).toContain("evicted idle worker dm:idle");
  });

  test("a hard breach must persist after cleanup before restart", async () => {
    const h = harness({ rssMiB: 9 });
    await h.governor.tick();
    h.advance();
    await h.governor.tick();
    h.advance();
    await h.governor.tick();
    expect(h.counts().restarts).toBe(1);
    expect(h.status()?.action).toContain("graceful restart requested");
  });

  test("never interrupts an active resident turn", async () => {
    const h = harness({ busy: true, rssMiB: 9 });
    for (let i = 0; i < 3; i++) {
      await h.governor.tick();
      h.advance();
    }
    // Nothing idle to evict and a turn in flight: the restart waits.
    expect(h.counts().restarts).toBe(0);
    expect(h.counts().trims).toBe(1);
    expect(h.status()?.action).toContain("deferred until active turns finish");
  });

  test("rejects an inverted memory budget", () => {
    const h = harness();
    expect(
      () =>
        new ResourceGovernor(
          {
            softLimitBytes: 8 * MIB,
            hardLimitBytes: 8 * MIB,
            sustainedSamples: 3,
            intervalMs: 10_000,
            restartOnHardLimit: true,
          },
          // Reuse the valid instance's private dependency shape indirectly is
          // impossible; this branch only needs construction-time validation.
          {} as ResourceGovernorDeps,
        ),
    ).toThrow("soft limit must be below hard limit");
    h.governor.stop();
  });
});

describe("resource governor counts footprint, not RSS", () => {
  test("memory that was compressed or swapped out still counts", async () => {
    // The 2026-10-25 shape: little resident, most of it compressed.
    const h = harness({ rssMiB: 3, footprintMiB: 9 });
    for (let i = 0; i < 3; i++) {
      await h.governor.tick();
      h.advance();
    }
    expect(h.status()?.pressure).toBe("hard");
    expect(h.counts().restarts).toBe(1);
    expect(h.status()?.managed.footprintBytes).toBe(9 * MIB);
  });

  test("shared library pages counted in RSS do not set off relief", async () => {
    const h = harness({ rssMiB: 5, footprintMiB: 2 });
    const status = await h.governor.tick();
    expect(status?.pressure).toBe("normal");
    expect(h.counts().trims).toBe(0);
  });

  test("the largest process is the one with the largest footprint", () => {
    const rows = [
      { pid: process.pid, ppid: 1, pgid: 1, rssBytes: 100, footprintBytes: 50, command: "bun" },
      { pid: 41, ppid: process.pid, pgid: 1, rssBytes: 400, footprintBytes: 60, command: "claude" },
      {
        pid: 42,
        ppid: process.pid,
        pgid: 1,
        rssBytes: 90,
        footprintBytes: 900,
        command: "python3",
      },
    ];
    const summary = summarizeManagedProcesses(rows, process.pid, []);
    expect(summary.largest?.pid).toBe(42);
    expect(summary.footprintBytes).toBe(1010);
    expect(summary.rssBytes).toBe(590);
  });

  test.if(process.platform === "darwin")("reads a live footprint from the kernel", () => {
    const read = makeFootprintReader();
    const mine = read(process.pid);
    expect(mine).not.toBeNull();
    expect(mine!).toBeGreaterThan(MIB);
    // A pid that does not exist has no footprint rather than a zero.
    expect(read(999_999)).toBeNull();
  });
});
