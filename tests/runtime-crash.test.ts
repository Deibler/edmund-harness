import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRASH_ALERT_EVERY_MS,
  crashesSinceLastBoot,
  describeUptime,
  findRuntimeCrashes,
} from "../src/boot/runtime-crash.ts";

// The shape of a real report from the daemon's stderr, 2026-11-16.
const DAEMON_CRASH = `[recall] coverage document counts were slow ms=625
============================================================
Bun v1.3.9 (cf6cdbbb) macOS Silicon
macOS v26.4.1
CPU: fp aes crc32 atomics
Args: "/opt/homebrew/bin/bun" "src/main.ts"
Features: Bun.stderr(2) fetch(400) spawn(1067) workers_spawned(373) workers_terminated(372)
Builtins: "bun:ffi" "bun:main" "bun:sqlite" "node:assert"
Elapsed: 12379472ms | User: 441299ms | Sys: 153174ms
RSS: 2.55GB | Peak: 2.55GB | Commit: 0.02ZB | Faults: 1210 | Machine: 17.18GB

panic: Segmentation fault at address 0x4EEA4000000
oh no: Bun has crashed. This indicates a bug in Bun, not your code.

To send a redacted crash report to Bun's team,
please file a GitHub issue using the link below:

 https://bun.report/1.3.9/Ma1cf6cdbbizH+1o4C_ml0nW2zA28uChgggg8C

[recall] coverage document counts were slow ms=572
`;

// A child's crash, relayed through the daemon's stderr with its own program.
const CHILD_CRASH = `[claude-worker] stderr: ============================================================
Bun v1.4.4 (388955fac) macOS Silicon session=dm:+15555550101
[claude-worker] stderr: macOS v26.4.1
CPU: neon fp aes crc32 atomics
Args: "claude" "--zero-fill-buffers" "-p" "--output-format" "stream-json"
Elapsed: 211ms | User: 100ms | Sys: 40ms

panic(main thread): Bus error at address 0x2EEBE308140
oh no: Bun has crashed. This indicates a bug in Bun, not your code.

 https://bun.report/1.4.4/Ma1388955fmgggkoBuhogC_ml4vsGA48uBhs/95hC
`;

describe("reading a crash report out of stderr", () => {
  test("the daemon's own crash is found with what it says", () => {
    expect(findRuntimeCrashes(DAEMON_CRASH, "main.ts")).toEqual([
      {
        runtime: "Bun v1.3.9",
        panic: "Segmentation fault at address 0x4EEA4000000",
        uptimeMs: 12379472,
        report: "https://bun.report/1.3.9/Ma1cf6cdbbizH+1o4C_ml0nW2zA28uChgggg8C",
      },
    ]);
  });

  test("a child's crash in the same file is not the daemon's", () => {
    expect(findRuntimeCrashes(CHILD_CRASH, "main.ts")).toEqual([]);
    const both = findRuntimeCrashes(CHILD_CRASH + DAEMON_CRASH + CHILD_CRASH, "main.ts");
    expect(both.map((c) => c.runtime)).toEqual(["Bun v1.3.9"]);
  });

  test("ordinary stderr holds no crash", () => {
    expect(findRuntimeCrashes("[recall] embed batch failed\n[alert] sent\n", "main.ts")).toEqual(
      [],
    );
  });

  test("two crashes are two crashes", () => {
    expect(findRuntimeCrashes(DAEMON_CRASH + DAEMON_CRASH, "main.ts").length).toBe(2);
  });

  test("uptime reads as minutes, then hours", () => {
    expect(describeUptime(12379472)).toBe("3.4 h");
    expect(describeUptime(660_000)).toBe("11 min");
    expect(describeUptime(null)).toBe("unknown");
  });
});

describe("crashes since the last boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-crash-"));
  const stderrPath = join(dir, "launchd.err.log");
  const cursorPath = join(dir, "cursor.json");
  const boot = (nowMs = 1_000_000) =>
    crashesSinceLastBoot({ stderrPath, cursorPath, entry: "main.ts", nowMs });

  afterEach(() => {
    rmSync(stderrPath, { force: true });
    rmSync(cursorPath, { force: true });
  });

  test("the first boot does not report the file's history", () => {
    writeFileSync(stderrPath, DAEMON_CRASH);
    expect(boot()).toEqual({ crashes: [], alert: false });
  });

  test("a crash written after one boot is reported by the next, once", () => {
    writeFileSync(stderrPath, "[boot] quiet\n");
    boot();
    appendFileSync(stderrPath, DAEMON_CRASH);
    const next = boot(CRASH_ALERT_EVERY_MS + 1);
    expect(next.crashes.length).toBe(1);
    expect(next.alert).toBe(true);
    // Nothing new since: nothing to say.
    expect(boot(CRASH_ALERT_EVERY_MS + 2)).toEqual({ crashes: [], alert: false });
  });

  test("a crash loop is logged every time and alerts once", () => {
    writeFileSync(stderrPath, "");
    boot();
    const t0 = CRASH_ALERT_EVERY_MS + 1;
    appendFileSync(stderrPath, DAEMON_CRASH);
    expect(boot(t0).alert).toBe(true);
    appendFileSync(stderrPath, DAEMON_CRASH);
    const again = boot(t0 + 30_000);
    expect(again.crashes.length).toBe(1);
    expect(again.alert).toBe(false);
    appendFileSync(stderrPath, DAEMON_CRASH);
    expect(boot(t0 + CRASH_ALERT_EVERY_MS).alert).toBe(true);
  });

  test("a rotated file is read from its start", () => {
    writeFileSync(stderrPath, "x".repeat(50_000));
    boot();
    writeFileSync(stderrPath, DAEMON_CRASH);
    expect(boot(CRASH_ALERT_EVERY_MS + 1).crashes.length).toBe(1);
  });

  test("no stderr file is not an error", () => {
    expect(boot()).toEqual({ crashes: [], alert: false });
  });
});
