import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { personFilePath } from "../claude/persona.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";
import { ensurePersonFile } from "./ensure.ts";

/**
 * Read-write helpers for `persona/people/<handle>.md`. The model can get
 * surgical via read → edit → write: read the current file, modify, write
 * back the full replacement. An atomic backup (.bak) is kept so a bad write
 * is recoverable.
 */

export function readPersonFile(handle: string): { path: string; body: string } | null {
  const path = personFilePath(handle);
  if (!existsSync(path)) return null;
  return { path, body: readFileSync(path, "utf8") };
}

export function writePersonFile(params: {
  handle: string;
  displayName: string | null;
  body: string;
}): string {
  ensurePersonFile(params.handle, params.displayName);
  const path = personFilePath(params.handle);
  // Rollback copy of the previous version. Copy (not rename) so the
  // file at `path` stays continuously readable for the live model —
  // the rename in atomicWriteFileSync is what swaps it in-place.
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
    } catch {}
  }
  const trimmed = params.body.trimEnd();
  atomicWriteFileSync(path, `${trimmed}\n`);
  return path;
}
