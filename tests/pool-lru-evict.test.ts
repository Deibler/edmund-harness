/**
 * Memory relief evicts one idle worker at a time, least recently used first,
 * instead of flushing every warm worker (2026-10-29). A worker in a turn is
 * never chosen, and one used recently is protected, so the conversation in
 * progress keeps its warm worker. Real workers, fake CLI on PATH.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerPool } from "../src/claude/pool.ts";

const bin = mkdtempSync(join(tmpdir(), "fake-claude-pool-"));
const slowBin = mkdtempSync(join(tmpdir(), "fake-claude-pool-slow-"));
for (const [dir, fixture] of [
  [bin, "fake-claude-resume.ts"],
  [slowBin, "fake-claude-midturn.ts"],
] as const) {
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", fixture)}" "$@"\n`,
  );
  chmodSync(join(dir, "claude"), 0o755);
}
afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
  rmSync(slowBin, { recursive: true, force: true });
});

const user = (text: string) =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
const spawnFor = (sessionKey: string, dir: string, env: Record<string, string> = {}) => ({
  argv: [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--replay-user-messages",
  ],
  env: { ...(process.env as Record<string, string>), PATH: `${dir}:${process.env.PATH}`, ...env },
  cwd: dir,
  perTurnIdleMs: 10_000,
  sessionKey,
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WorkerPool.evictLruIdle", () => {
  test("evicts the oldest idle worker, never a busy or recently used one", async () => {
    const pool = new WorkerPool({ maxWorkers: 6, idleEvictMs: 3_600_000, perTurnIdleMs: 10_000 });
    try {
      for (const key of ["dm:a", "dm:b", "dm:c"]) {
        const r = await pool.run({
          sessionKey: key,
          rebindKey: "k",
          spawn: spawnFor(key, bin),
          payload: { stdinPayload: user("hi") },
        });
        expect(r.ok).toBe(true);
        await pause(30);
      }
      const busy = pool.run({
        sessionKey: "dm:busy",
        rebindKey: "k",
        spawn: spawnFor("dm:busy", slowBin, { FAKE_TOOL_MS: "2000" }),
        payload: { stdinPayload: user("work") },
      });
      await pause(300);
      expect(pool.getStats().workers.every((w) => typeof w.pid === "number")).toBe(true);

      expect(await pool.evictLruIdle("test", 0)).toBe("dm:a");
      expect(await pool.evictLruIdle("test", 0)).toBe("dm:b");
      // dm:c was used moments ago: protected under a recency guard.
      expect(await pool.evictLruIdle("test", 60_000)).toBeNull();
      expect(await pool.evictLruIdle("test", 0)).toBe("dm:c");
      // Only the busy worker is left, and it is never chosen.
      expect(await pool.evictLruIdle("test", 0)).toBeNull();
      expect((await busy).ok).toBe(true);
    } finally {
      await pool.stop();
    }
  }, 20_000);
});
