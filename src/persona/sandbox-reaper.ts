import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../util/log.ts";

/**
 * Daily-ish cleanup of stale machine-generated assets in every sandbox.
 *
 * Categories swept (each under `sandbox/<dir>/<subdir>/`):
 *   - `.resized/`   — image-resize cache from src/media/image-resize.ts
 *   - `screenshot/` — bg cf-execute screenshots
 *   - `pdf/`        — bg cf-execute PDFs
 *   - `markdown/`   — bg cf-execute readable extracts
 *   - `content/`    — bg cf-execute raw HTML
 *   - `html/`       — bg cf-execute paired HTML+screenshot dumps
 *   - `json/`       — bg cf-execute link/scrape JSON dumps
 *   - `.inline-images/` — runner-side per-turn inline image cache (claude/runner.ts)
 *
 * NOT swept: anything the model placed itself (top-level files,
 * project subdirs, persona files). Those are model-owned content and
 * deletion would be destructive. The README in the sandbox tells the
 * model it's responsible for pruning its own work.
 *
 * Without this, a long-running daemon accumulates indefinitely — the
 * only existing cleanup is "session evicted", which may never happen
 * for an active thread.
 */

const CACHE_SUBDIRS = [
  ".resized",
  ".inline-images",
  "screenshot",
  "pdf",
  "markdown",
  "content",
  "html",
  "json",
] as const;

export type ReapStats = {
  sandboxesScanned: number;
  filesDeleted: number;
  bytesFreed: number;
};

export function reapSandboxCaches(opts: {
  sandboxRoot: string;
  maxAgeMs: number;
}): ReapStats {
  const stats: ReapStats = { sandboxesScanned: 0, filesDeleted: 0, bytesFreed: 0 };
  let entries: string[];
  try {
    entries = readdirSync(opts.sandboxRoot);
  } catch {
    return stats; // sandbox root doesn't exist yet
  }
  const cutoff = Date.now() - opts.maxAgeMs;
  for (const name of entries) {
    const sandboxDir = join(opts.sandboxRoot, name);
    try {
      if (!statSync(sandboxDir).isDirectory()) continue;
    } catch {
      continue;
    }
    stats.sandboxesScanned++;
    for (const sub of CACHE_SUBDIRS) {
      reapDir(join(sandboxDir, sub), cutoff, stats);
    }
  }
  if (stats.filesDeleted > 0) {
    log.info("sandbox-reaper", "swept stale cache files", {
      sandboxes: stats.sandboxesScanned,
      files_deleted: stats.filesDeleted,
      bytes_freed: stats.bytesFreed,
    });
  }
  return stats;
}

function reapDir(dir: string, cutoff: number, stats: ReapStats): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir absent
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isDirectory()) {
        reapDir(path, cutoff, stats);
        continue;
      }
      if (st.mtimeMs < cutoff) {
        rmSync(path, { force: true });
        stats.filesDeleted++;
        stats.bytesFreed += st.size;
      }
    } catch {
      // Best-effort; skip on any per-file error.
    }
  }
}
