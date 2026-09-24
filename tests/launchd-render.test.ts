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
