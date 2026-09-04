import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir } from "./session-store.ts";

/**
 * Claude API rejects any single request whose total payload exceeds 32 MB.
 * For long-lived sessions accumulating image content blocks (every voice
 * note, every reference photo, every screenshot the user sends gets baked
 * into the session JSONL as base64), the cumulative payload eventually
 * crosses the limit and every `--resume` afterwards fails.
 *
 * This module shrinks a session JSONL in place by replacing image content
 * blocks (`{type: "image", source: {type: "base64", data: ...}}`) with a
 * small text placeholder, starting from the oldest message and stopping as
 * soon as the projected file size is below the target. The original image
 * file is still on disk under the sandbox's `received-images/` (or
 * `images/`) directory — the model can re-Read it if needed, so we're not
 * losing visual context, just trimming what gets re-sent with every turn.
 *
 * Two invocation points (see runner.ts):
 *   - Preventive: before each resume, when the session file is above
 *     SESSION_SIZE_SOFT_LIMIT, trim to TARGET_AFTER_COMPACT.
 *   - Reactive: when a resume fails with `isRequestTooLargeError`, trim
 *     more aggressively to REACTIVE_TARGET and retry once.
 *
 * The preventive limit sits far below the 32 MB wall on purpose: the
 * whole prefix — every retained image — rides in the HTTP body of every
 * API round-trip of every turn (prompt caching skips re-tokenizing, not
 * re-uploading). Trimming oldest-first at a few MB keeps that payload
 * small for the life of a long session; the newest images (the ones a
 * conversation is actually about) are the last to go, and anything
 * trimmed is still one Read away on disk.
 */

export const SESSION_SIZE_SOFT_LIMIT = 10_000_000; // ~10 MB — keep per-request payloads small
export const TARGET_AFTER_COMPACT = 8_000_000; // ~8 MB — headroom so the sweep isn't every turn
export const REACTIVE_TARGET = 6_000_000; // ~6 MB — aggressive when a resume already bounced

export const PLACEHOLDER_TEXT =
  "[older image elided to keep this session under the 32 MB request limit. The original file is still on disk under this conversation's sandbox; Read the path if you need to reinspect it.]";

export type CompactResult = {
  beforeBytes: number;
  afterBytes: number;
  imagesCompacted: number;
  totalImages: number;
  changed: boolean;
};

/**
 * Compute the on-disk path of a Claude Code session JSONL for a given
 * sandbox cwd + sessionId. Mirrors the encoding in session-store.ts and
 * always returns the path under `~/.claude/projects/<encoded>/<id>.jsonl`
 * (which is a symlink into `persona/sessions/<encoded>/`).
 */
export function sessionFilePath(sandboxPath: string, sessionId: string): string {
  const slug = encodeProjectDir(sandboxPath);
  return join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

/**
 * Replace the oldest image content blocks with text placeholders until the
 * file is below `targetBytes`. Returns metrics describing what happened.
 *
 * Atomic: writes to a `.tmp` file then renames, so a crash mid-compact
 * leaves the original session intact. Preserves the original file's
 * permission bits.
 */
export function compactSession(filePath: string, targetBytes: number): CompactResult {
  if (!existsSync(filePath)) {
    return { beforeBytes: 0, afterBytes: 0, imagesCompacted: 0, totalImages: 0, changed: false };
  }
  const beforeBytes = statSync(filePath).size;
  if (beforeBytes <= targetBytes) {
    return {
      beforeBytes,
      afterBytes: beforeBytes,
      imagesCompacted: 0,
      totalImages: 0,
      changed: false,
    };
  }

  const original = readFileSync(filePath, "utf8");
  const lines = original.split("\n");

  // Total images across the whole file (informational metric only).
  let totalImages = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      totalImages += countImages(JSON.parse(line));
    } catch {}
  }

  let imagesCompacted = 0;
  let runningBytes = beforeBytes;

  // Walk lines oldest → newest. Within each line, compactLineToTarget
  // replaces image blocks until either the line has no more images or
  // we're under target. We use byte-delta from re-serializing to keep
  // runningBytes accurate.
  for (let i = 0; i < lines.length; i++) {
    if (runningBytes <= targetBytes) break;
    const line = lines[i];
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // Approximate budget tracking *within* a single line: each replacement
    // saves ~ data.length bytes. Lets us short-circuit so we don't strip
    // every image from one record when only one or two were needed.
    let approxSavingsThisLine = 0;
    const replaced = compactRecordImages(
      rec,
      () => runningBytes - approxSavingsThisLine > targetBytes,
      (savedBytes) => {
        approxSavingsThisLine += savedBytes;
      },
    );
    if (replaced === 0) continue;
    // Exact: re-serialize and use the real byte delta.
    const newLine = JSON.stringify(rec);
    runningBytes -= line.length - newLine.length;
    lines[i] = newLine;
    imagesCompacted += replaced;
  }

  // Nothing replaceable (imageless file over target, or images already
  // placeholdered): leave the file untouched instead of rewriting an
  // identical copy — this path runs on every cold spawn once a session
  // crosses the (now much lower) target size.
  if (imagesCompacted === 0) {
    return {
      beforeBytes,
      afterBytes: beforeBytes,
      imagesCompacted: 0,
      totalImages,
      changed: false,
    };
  }

  // Preserve original mode (typically 0o600 for Claude session files).
  const mode = statSync(filePath).mode & 0o777;
  const tmpPath = `${filePath}.compact.tmp`;
  writeFileSync(tmpPath, lines.join("\n"));
  try {
    renameSync(tmpPath, filePath);
    if (mode) chmodSync(filePath, mode);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }

  return {
    beforeBytes,
    afterBytes: statSync(filePath).size,
    imagesCompacted,
    totalImages,
    changed: imagesCompacted > 0,
  };
}

/**
 * Walk one record's content blocks and replace each base64 image with a
 * text placeholder, **stopping** as soon as `stillOverBudget()` returns
 * false. `onReplace` is a per-replacement hook (unused for accounting now;
 * kept as an extension point).
 *
 * Mutates `rec` in place. Returns the count of replaced images.
 */
function compactRecordImages(
  rec: unknown,
  stillOverBudget: () => boolean,
  onReplace: (savedBytes: number) => void,
): number {
  let replaced = 0;
  walkContentBlocks(rec, (block, parent, key) => {
    if (!isBase64Image(block)) return;
    if (!stillOverBudget()) return;
    const savedBytes = block.source.data.length - PLACEHOLDER_TEXT.length;
    const placeholder = { type: "text", text: PLACEHOLDER_TEXT };
    if (Array.isArray(parent)) {
      parent[key as number] = placeholder;
    } else {
      (parent as Record<string, unknown>)[key as string] = placeholder;
    }
    replaced++;
    onReplace(savedBytes);
  });
  return replaced;
}

type Base64ImageBlock = {
  type: "image";
  source: { type: "base64"; data: string; media_type?: string };
};

function isBase64Image(b: unknown): b is Base64ImageBlock {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  if (o.type !== "image") return false;
  const src = o.source;
  if (!src || typeof src !== "object") return false;
  const s = src as Record<string, unknown>;
  return s.type === "base64" && typeof s.data === "string";
}

function countImages(rec: unknown): number {
  let n = 0;
  walkContentBlocks(rec, (block) => {
    if (isBase64Image(block)) n++;
  });
  return n;
}

/**
 * Visit every node in `rec`. Callback receives the node, its parent
 * container (object or array), and the key/index it occupies in that
 * parent — so the callback can replace the node in place.
 */
function walkContentBlocks(
  rec: unknown,
  visit: (block: unknown, parent: unknown, key: string | number) => void,
): void {
  const seen = new WeakSet<object>();
  const stack: Array<{ node: unknown; parent: unknown; key: string | number | null }> = [
    { node: rec, parent: null, key: null },
  ];
  while (stack.length > 0) {
    const { node, parent, key } = stack.pop()!;
    if (!node || typeof node !== "object") continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);

    if (parent !== null && key !== null) visit(node, parent, key);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        stack.push({ node: node[i], parent: node, key: i });
      }
    } else {
      for (const [k, v] of Object.entries(node)) {
        stack.push({ node: v, parent: node, key: k });
      }
    }
  }
}
