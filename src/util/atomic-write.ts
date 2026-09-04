import { renameSync, writeFileSync } from "node:fs";

/**
 * Soft cap for any single text file written via this helper. Persona
 * files (~10-50 KB healthy) and self-memory files run through here;
 * a runaway model or maintainer bug could otherwise balloon them
 * unbounded. 1 MiB is ~20x the largest healthy file we've ever seen.
 */
const MAX_TEXT_FILE_BYTES = 1 * 1024 * 1024;

/**
 * Write `body` to `path` atomically: write to a sibling temp file, fsync
 * implicitly via Bun's writeFileSync, then rename over the destination.
 *
 * On POSIX `rename(2)` is atomic for paths on the same filesystem, so a
 * concurrent reader sees either the old file or the new file — never a
 * half-written one. This matters for persona files, which the live
 * model may read at any moment.
 *
 * Best-effort `.bak` of the prior contents is kept by callers that need
 * rollback; this helper just does the write.
 *
 * @public Imported by src/persona/{crud,write-note,groups,self-memory}.ts.
 * Tagged because knip does not resolve those importers and reports this as
 * unused; removing it fails the typecheck immediately.
 */
export function atomicWriteFileSync(path: string, body: string | Uint8Array): void {
  const size = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
  if (size > MAX_TEXT_FILE_BYTES) {
    throw new Error(
      `atomicWriteFileSync: refusing to write ${size}b to ${path} (limit ${MAX_TEXT_FILE_BYTES}b). Persona/self-memory files this large indicate runaway content; trim or split before retrying.`,
    );
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}
