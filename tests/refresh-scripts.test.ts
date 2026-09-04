/**
 * Deterministic refresh scripts (Phase-3): model authors a fetch+render
 * script once; the daemon runs it on schedule with zero model turns. These
 * tests cover the store bookkeeping, the sandboxed subprocess runner, the
 * watcher's backoff/escalation, and the repair-event wording.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PERSISTENT_REFRESH_FAILURE_AT,
  RefreshWatcher,
  buildRefreshRepairEvent,
  effectiveRefreshIntervalMs,
  runRefreshScriptSource,
} from "../src/refresh/runner.ts";
import { type RefreshScript, RefreshScriptStore } from "../src/refresh/store.ts";

const KEY = "mirror:pi-4";

function withStore(fn: (s: RefreshScriptStore) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "refresh-"));
  const s = new RefreshScriptStore(dir);
  const done = () => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const r = fn(s);
  if (r instanceof Promise) return r.finally(done);
  done();
}

function arm(
  s: RefreshScriptStore,
  over: Partial<Parameters<RefreshScriptStore["create"]>[0]> = {},
) {
  return s.create({
    sessionKey: KEY,
    name: "weather-widget",
    brief: "keep the weather widget current from api.weather.gov",
    script: "return { id: 'weather' };",
    applyKind: "mirror_content",
    intervalMs: 60 * 60_000,
    ...over,
  });
}

describe("runRefreshScriptSource", () => {
  test("async body runs with a return value", async () => {
    const r = await runRefreshScriptSource(
      "const x = await Promise.resolve(41); return { n: x + 1 };",
    );
    expect(r).toEqual({ ok: true, value: { n: 42 } });
  });

  test("throwing script reports its error", async () => {
    const r = await runRefreshScriptSource("throw new Error('shape changed');");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("shape changed");
  });

  test("runaway script is killed at the timeout", async () => {
    const r = await runRefreshScriptSource("while (true) {}", 1_500);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timed out");
  }, 15_000);
});

describe("RefreshScriptStore", () => {
  test("markRun success resets failures; failure increments", () => {
    withStore((s) => {
      const a = arm(s);
      s.markRun(a.id, 1_000, { ok: false, error: "boom" });
      s.markRun(a.id, 2_000, { ok: false, error: "boom" });
      expect(s.get(a.id)?.consecutiveFailures).toBe(2);
      s.markRun(a.id, 3_000, { ok: true, summary: "applied weather r5" });
      const row = s.get(a.id);
      expect(row?.consecutiveFailures).toBe(0);
      expect(row?.lastError).toBeNull();
      expect(row?.lastOkMs).toBe(3_000);
      expect(row?.lastSummary).toBe("applied weather r5");
    });
  });

  test("findArmedByName supports replace-on-re-arm", () => {
    withStore((s) => {
      const a = arm(s);
      expect(s.findArmedByName(KEY, "weather-widget")?.id).toBe(a.id);
      s.cancel(a.id, KEY);
      expect(s.findArmedByName(KEY, "weather-widget")).toBeNull();
    });
  });
});

describe("RefreshWatcher", () => {
  test("due script runs, applies, and records; failure backs off and escalates once", async () => {
    await withStore(async (s) => {
      const a = arm(s, { intervalMs: 60_000, script: "return { ok: 1 };" });
      let applyOk = true;
      const escalations: number[] = [];
      const w = new RefreshWatcher({
        store: s,
        intervalMs: 999_999,
        apply: async () =>
          applyOk ? { ok: true, summary: "applied" } : { ok: false, error: "glass rejected it" },
        escalate: (_s, _e, failures) => escalations.push(failures),
      });
      await w.tick(1_000_000);
      expect(s.get(a.id)?.lastOkMs).toBe(1_000_000);

      applyOk = false;
      await w.tick(1_070_000); // due (60s past) → failure #1
      expect(s.get(a.id)?.consecutiveFailures).toBe(1);
      await w.tick(1_100_000); // within 120s backoff → skipped
      expect(s.get(a.id)?.consecutiveFailures).toBe(1);
      await w.tick(1_200_000); // → failure #2
      await w.tick(1_500_000); // → failure #3 → escalate
      await w.tick(2_200_000); // → failure #4 — no second escalation
      expect(escalations).toEqual([PERSISTENT_REFRESH_FAILURE_AT]);

      applyOk = true;
      await w.tick(3_500_000); // recovery resets
      expect(s.get(a.id)?.consecutiveFailures).toBe(0);
    });
  });

  test("effectiveRefreshIntervalMs caps at 6h and never undercuts the base", () => {
    const base = { intervalMs: 60 * 60_000, consecutiveFailures: 0 } as RefreshScript;
    expect(effectiveRefreshIntervalMs(base)).toBe(3_600_000);
    expect(effectiveRefreshIntervalMs({ ...base, consecutiveFailures: 1 })).toBe(7_200_000);
    expect(effectiveRefreshIntervalMs({ ...base, consecutiveFailures: 10 })).toBe(21_600_000);
    expect(
      effectiveRefreshIntervalMs({
        ...base,
        intervalMs: 12 * 3_600_000,
        consecutiveFailures: 3,
      }),
    ).toBe(12 * 3_600_000);
  });
});

describe("buildRefreshRepairEvent", () => {
  test("carries id, brief, error, and both repair actions", () => {
    const s = {
      id: "rfs_1",
      name: "weather-widget",
      brief: "keep weather current",
    } as RefreshScript;
    const ev = buildRefreshRepairEvent(s, "HTTP 500 from api.weather.gov", 3);
    expect(ev).toContain("rfs_1");
    expect(ev).toContain("keep weather current");
    expect(ev).toContain("HTTP 500");
    expect(ev).toContain("set_refresh_script");
    expect(ev).toContain("cancel_refresh_script");
    expect(ev).toContain("manually");
  });
});
