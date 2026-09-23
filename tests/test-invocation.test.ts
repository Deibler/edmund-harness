/**
 * Every `bun test` the project runs is given paths, not name filters.
 *
 * Bun reads `tests/` (no leading `./`) as a filter over the whole checkout. A
 * local run then also executed the stale copies of this repo in the session
 * worktrees under `sandbox/` and vendored specs, and held about 14,000 file
 * descriptors open, which left child processes' piped output empty: the
 * ffprobe round-trip failed for a reason that had nothing to do with video.
 * Measured 2026-09-23: 30 descriptors by path against 14,290 by filter.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function testCommands(): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const scripts = Object.values(pkg.scripts).filter((s) => s.startsWith("bun test"));
  return [...scripts, ...(ci.match(/bun test[^\n]*/g) ?? [])];
}

test("the package script and CI give bun test paths starting with ./", () => {
  const commands = testCommands();
  expect(commands.length).toBeGreaterThanOrEqual(2);
  for (const cmd of commands) {
    const targets = cmd
      .replace(/^bun test/, "")
      .split(/\s+/)
      .filter((a) => a && !a.startsWith("-"));
    expect({ cmd, hasTargets: targets.length > 0 }).toEqual({ cmd, hasTargets: true });
    for (const target of targets) {
      expect({ cmd, target, isPath: target.startsWith("./") }).toEqual({
        cmd,
        target,
        isPath: true,
      });
    }
  }
});
