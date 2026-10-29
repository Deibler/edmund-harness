/**
 * `service.sh` renders each LaunchAgent from a committed template. On one
 * install the agent in ~/Library/LaunchAgents was a symlink to the template
 * instead: launchd ran the placeholder paths and exited 78 on every start, and
 * the tunnel it managed stayed down for eight days. Rendering through that
 * symlink would also have emptied the tracked template. These run the real
 * `render_plist` from the script against that state.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "launchd", "service.sh");
const DIR = mkdtempSync(join(tmpdir(), "launchd-render-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const TEMPLATE = "<string>__HARNESS_ROOT__/run.sh</string><string>__HOME__/log</string>\n";

/** Source only the function out of service.sh, then call it. */
function render(src: string, dest: string): void {
  const run = Bun.spawnSync([
    "bash",
    "-c",
    `REPO_ROOT=/repo; HOME=/home; eval "$(awk '/^render_plist\\(\\) \\{/,/^\\}/' "$0")"; render_plist "$1" "$2"`,
    SCRIPT,
    src,
    dest,
  ]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

describe("render_plist", () => {
  test("fills in the placeholders", () => {
    const src = join(DIR, "a.plist");
    const dest = join(DIR, "a.out.plist");
    writeFileSync(src, TEMPLATE);
    render(src, dest);
    expect(readFileSync(dest, "utf8")).toBe(
      "<string>/repo/run.sh</string><string>/home/log</string>\n",
    );
  });

  test("replaces an agent that is a symlink to its template, and leaves the template alone", () => {
    const src = join(DIR, "b.plist");
    const dest = join(DIR, "b.out.plist");
    writeFileSync(src, TEMPLATE);
    symlinkSync(src, dest);
    render(src, dest);
    expect(readFileSync(src, "utf8")).toBe(TEMPLATE);
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf8")).not.toContain("__HARNESS_ROOT__");
  });
});

/**
 * `launchctl bootout` returns before the job has finished unloading, and a
 * bootstrap in that window fails with error 5. Under `set -e` service.sh then
 * stopped with the old job gone and the new one never loaded: on 2026-10-29
 * an install left the daemon down until it was bootstrapped by hand. The fake
 * launchctl below keeps the job unloading for two polls and fails a bootstrap
 * issued during them, as the real one did.
 */
describe("reload_agent", () => {
  function reload(): { code: number; calls: string[] } {
    const log = join(DIR, `launchctl-${Math.random().toString(36).slice(2)}.log`);
    writeFileSync(log, "");
    const run = Bun.spawnSync([
      "bash",
      "-c",
      `set -euo pipefail; DOMAIN=gui/501; LOG="$1"; state=loaded; polls=0
       launchctl() {
         echo "$1" >> "$LOG"
         case "$1" in
           bootout) state=unloading ;;
           print)
             case "$state" in
               loaded) return 0 ;;
               unloading) polls=$((polls + 1)); if (( polls > 2 )); then state=gone; return 1; fi; return 0 ;;
               *) return 1 ;;
             esac ;;
           bootstrap) [[ "$state" == gone ]] || { echo "Bootstrap failed: 5: Input/output error" >&2; return 5; }; state=loaded ;;
         esac
       }
       sleep() { :; }
       eval "$(awk '/^reload_agent\\(\\) \\{/,/^\\}/' "$0")"
       reload_agent com.example.agent /x.plist`,
      SCRIPT,
      log,
    ]);
    return { code: run.exitCode, calls: readFileSync(log, "utf8").trim().split("\n") };
  }

  test("waits for the old job to unload before loading the new one", () => {
    const { code, calls } = reload();
    expect(code).toBe(0);
    expect(calls[0]).toBe("bootout");
    expect(calls.at(-1)).toBe("bootstrap");
    expect(calls.filter((c) => c === "print").length).toBe(3);
  });

  test("every install in service.sh loads through it", () => {
    const script = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"));
    expect(script.filter((l) => l.includes("launchctl bootstrap")).length).toBe(1);
    expect(script.filter((l) => /^\s*reload_agent "/.test(l)).length).toBe(5);
  });
});
