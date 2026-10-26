/**
 * The sandboxes and the conversation transcripts may live on another disk,
 * with `sandbox` and `persona/sessions` symlinked to it, so every absolute
 * path already written into cron jobs, venvs, worktrees and the databases
 * keeps working. When that disk is not mounted the links dangle, and the
 * daemon must not start: a resume would find no transcript and every
 * conversation would quietly begin again from nothing.
 */

import { lstatSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";

export const MOVABLE_STORAGE = ["sandbox", join("persona", "sessions")];

/** One line per linked location whose target is missing; empty when all is well. */
export function missingStorage(repoRoot: string): string[] {
  const missing: string[] = [];
  for (const rel of MOVABLE_STORAGE) {
    const path = join(repoRoot, rel);
    let linked = false;
    try {
      linked = lstatSync(path).isSymbolicLink();
    } catch {
      continue; // Not there at all: created on first use, as before.
    }
    if (!linked) continue;
    try {
      if (statSync(path).isDirectory()) continue;
    } catch {
      // Dangling.
    }
    missing.push(`${rel} -> ${readlinkSync(path)}`);
  }
  return missing;
}
