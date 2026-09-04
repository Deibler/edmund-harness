import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { ensureSandbox } from "../persona/sandbox.ts";
import type { SessionKey } from "../sessions/key.ts";
import { log } from "../util/log.ts";

/**
 * Cross-session media handoff for the relay.
 *
 * When the originator's session calls `message_contact` with attachments,
 * the files have to land somewhere the *recipient's* session can read —
 * separate sandboxes have a path guard that blocks reads outside their
 * own dir. We solve that by COPYING each file into the recipient's
 * sandbox under `received-from-<originator-slug>/<dated-basename>`. The
 * recipient's model can then:
 *   - see images directly (we pass them through cron's attachImages,
 *     which surface as multimodal content blocks on the receiving turn);
 *   - read non-image files (PDFs, docs, audio, video) via `Read` / the
 *     path-aware tools, then call `send_attachment(path)` to forward.
 *
 * Validation refuses paths that aren't absolute, don't exist, aren't
 * regular files, or exceed per-file / total caps (iMessage tops out at
 * 100 MB per attachment).
 */

const PER_FILE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB — iMessage hard cap
const TOTAL_MAX_BYTES = 250 * 1024 * 1024; // sanity cap across one relay
const MAX_FILES = 10;

const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".bmp",
  ".tiff",
]);

type StagedMedia = {
  /** Paths inside the recipient's sandbox. */
  paths: string[];
  /** Subset of `paths` that are images — eligible for cron's attachImages
   *  (so the receiving model sees them inline). */
  imagePaths: string[];
};

export type StageMediaArgs = {
  mediaPaths: string[];
  targetSessionKey: SessionKey;
  /** Display name used to label the destination dir
   *  (`received-from-<slug>`) so the recipient can tell who sent what. */
  originatorDisplayName: string;
};

export type StageMediaResult = { ok: true; staged: StagedMedia } | { ok: false; error: string };

export function stageRelayMedia(args: StageMediaArgs): StageMediaResult {
  if (args.mediaPaths.length === 0) {
    return { ok: true, staged: { paths: [], imagePaths: [] } };
  }
  if (args.mediaPaths.length > MAX_FILES) {
    return {
      ok: false,
      error: `too many files (${args.mediaPaths.length}); max ${MAX_FILES} per relay`,
    };
  }

  // Pre-validate everything before copying so a single bad path doesn't
  // leave a half-staged drop on disk.
  let total = 0;
  const validated: Array<{ src: string; bytes: number }> = [];
  for (const raw of args.mediaPaths) {
    const v = validatePath(raw);
    if (!v.ok) return v;
    total += v.bytes;
    if (total > TOTAL_MAX_BYTES) {
      return {
        ok: false,
        error: `total media size exceeds ${Math.round(TOTAL_MAX_BYTES / 1024 / 1024)} MB cap`,
      };
    }
    validated.push({ src: v.path, bytes: v.bytes });
  }

  // Stage into recipient's sandbox/received-from-<slug>/<timestamp>-<base>
  const targetSandbox = ensureSandbox(args.targetSessionKey, null);
  const dir = join(targetSandbox, `received-from-${slug(args.originatorDisplayName)}`);
  mkdirSync(dir, { recursive: true });

  const ts = isoStamp(new Date());
  const stagedPaths: string[] = [];
  const imagePaths: string[] = [];
  for (const { src } of validated) {
    const base = basename(src);
    const dest = uniquePath(join(dir, `${ts}__${base}`));
    try {
      copyFileSync(src, dest);
    } catch (err) {
      return {
        ok: false,
        error: `failed to copy ${src} → ${dest}: ${(err as Error).message}`,
      };
    }
    stagedPaths.push(dest);
    if (IMAGE_EXTS.has(extname(dest).toLowerCase())) imagePaths.push(dest);
  }

  log.info("relay-media", "staged", {
    target: args.targetSessionKey,
    count: stagedPaths.length,
    images: imagePaths.length,
    totalKb: Math.round(total / 1024),
  });
  return { ok: true, staged: { paths: stagedPaths, imagePaths } };
}

function validatePath(
  p: string,
): { ok: true; path: string; bytes: number } | { ok: false; error: string } {
  if (!p || typeof p !== "string") {
    return { ok: false, error: `invalid path: ${JSON.stringify(p)}` };
  }
  const abs = resolve(p);
  if (abs !== p && !p.startsWith("/")) {
    return { ok: false, error: `path must be absolute: ${p}` };
  }
  if (!existsSync(abs)) {
    return { ok: false, error: `file not found: ${abs}` };
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch (err) {
    return { ok: false, error: `stat failed for ${abs}: ${(err as Error).message}` };
  }
  if (!st.isFile()) {
    return { ok: false, error: `not a regular file: ${abs}` };
  }
  if (st.size === 0) {
    return { ok: false, error: `empty file: ${abs}` };
  }
  if (st.size > PER_FILE_MAX_BYTES) {
    return {
      ok: false,
      error: `${basename(abs)} is ${Math.round(st.size / 1024 / 1024)} MB, exceeds ${Math.round(PER_FILE_MAX_BYTES / 1024 / 1024)} MB iMessage cap`,
    };
  }
  return { ok: true, path: abs, bytes: st.size };
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  // Vanishingly rare (same ts + same basename + same recipient dir), but
  // guard with a numeric suffix anyway.
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return path; // last resort: overwrite
}

function slug(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "originator";
}

function isoStamp(d: Date): string {
  // YYYY-MM-DD_HHMMSS — sortable, filesystem-safe, no colons.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
