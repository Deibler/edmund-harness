import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOperatorActionable } from "../src/alerts/operator-alert.ts";
import {
  type CanaryResult,
  checkCliVersion,
  parseCliVersion,
  readVersionRecord,
} from "../src/claude/cli-canary.ts";

const dir = mkdtempSync(join(tmpdir(), "cli-canary-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function harness(version: string | null, result: CanaryResult) {
  const alerts: string[] = [];
  let canaryRuns = 0;
  return {
    alerts,
    runs: () => canaryRuns,
    deps: {
      dataDir: dir,
      model: "test-model",
      alert: {
        notify: async (p: { category: string; error: string }) => {
          alerts.push(`${p.category}: ${p.error}`);
          return true;
        },
      },
      readVersion: async () => version,
      canary: async () => {
        canaryRuns++;
        return result;
      },
    },
  };
}

describe("the CLI updates underneath, and the harness notices if it broke", () => {
  test("parses the version the CLI prints", () => {
    expect(parseCliVersion("2.1.310 (Claude Code)\n")).toBe("2.1.310");
    expect(parseCliVersion("garbage")).toBeNull();
  });

  test("a new version runs the canary and records it", async () => {
    const h = harness("2.1.310", { ok: true });
    const rec = await checkCliVersion(h.deps);
    expect(h.runs()).toBe(1);
    expect(rec?.canary).toBe("ok");
    expect(readVersionRecord(dir)?.version).toBe("2.1.310");
    expect(h.alerts).toEqual([]);
  });

  test("the same version that already passed is not re-checked", async () => {
    const h = harness("2.1.310", { ok: true });
    await checkCliVersion(h.deps);
    expect(h.runs()).toBe(0);
  });

  test("an update that breaks a path alerts with the version and the step", async () => {
    const h = harness("2.1.311", {
      ok: false,
      step: "stream-json worker",
      detail: "error: unknown option '--replay-user-messages'",
    });
    const rec = await checkCliVersion(h.deps);
    expect(rec?.canary).toBe("failed");
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain("2.1.311");
    expect(h.alerts[0]).toContain("was 2.1.310");
    expect(h.alerts[0]).toContain("stream-json worker");
  });

  test("a failed version is checked again next time, so a fix is noticed", async () => {
    const h = harness("2.1.311", { ok: true });
    await checkCliVersion(h.deps);
    expect(h.runs()).toBe(1);
    expect(readVersionRecord(dir)?.canary).toBe("ok");
  });

  test("a CLI that will not run alerts at once", async () => {
    const h = harness(null, { ok: true });
    expect(await checkCliVersion(h.deps)).toBeNull();
    expect(h.alerts[0]).toContain("not runnable");
  });

  test("a renamed flag in a live turn is operator-actionable", () => {
    expect(isOperatorActionable("error: unknown option '--system-prompt-snapshot'")).toBe(true);
    expect(isOperatorActionable("error: unrecognized option --foo")).toBe(true);
  });
});
