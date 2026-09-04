import { describe, expect, test } from "bun:test";
import {
  ResourceGovernor,
  type ResourceGovernorDeps,
  type ResourceStatus,
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

function harness(args?: { busy?: boolean; rssMiB?: number; trim?: number; flush?: number }) {
  let now = 1_000_000_000;
  let flushes = 0;
  let trims = 0;
  let restarts = 0;
  let lastStatus: ResourceStatus | null = null;
  const rss = (args?.rssMiB ?? 5) * MIB;
  const deps: ResourceGovernorDeps = {
    collectProcesses: async () => [
      { pid: process.pid, ppid: 1, pgid: process.pid, rssBytes: rss, command: "bun" },
    ],
    getWorkerPids: () => [],
    isBusy: () => args?.busy ?? false,
    flushWorkers: async () => {
      flushes++;
      return args?.flush ?? 0;
    },
    trimEmbeddings: () => {
      trims++;
      return args?.trim ?? 0;
    },
    collectMemory: () => ({ rss, heapUsed: MIB, external: MIB }),
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
    counts: () => ({ flushes, trims, restarts }),
    status: () => lastStatus,
  };
}

describe("resource governor actions", () => {
  test("soft pressure trims embeddings and evicts only idle workers", async () => {
    const h = harness({ trim: 1, flush: 2 });
    const status = await h.governor.tick();
    expect(status?.pressure).toBe("soft");
    expect(h.counts()).toEqual({ flushes: 1, trims: 1, restarts: 0 });
    expect(h.status()?.action).toContain("evicted 2 idle worker");
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
    expect(h.counts()).toEqual({ flushes: 0, trims: 1, restarts: 0 });
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
