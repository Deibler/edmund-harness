import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { log } from "../util/log.ts";

/**
 * Prep attachment paths for multimodal input to `claude -p`.
 *
 * Claude's vision supports jpeg, png, gif, webp. HEIC (iMessage's favorite)
 * must be converted — we use macOS `sips` because it's already installed on
 * every Mac mini this runs on. Anything else we skip with a warning so one
 * bad file doesn't break the whole turn.
 *
 * A few safety caps:
 *   - Per-image byte limit (~4 MB decoded): Claude rejects larger inlines.
 *   - Max images per turn: keep the request small so the session stays
 *     responsive. iMessage batches rarely carry more than a couple anyway.
 */

const SUPPORTED: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const CONVERTIBLE = new Set([".heic", ".heif", ".tiff", ".bmp"]);

/** Claude API caps each image around 5 MB decoded. Give ourselves headroom. */
const MAX_BYTES_PER_IMAGE = 4_500_000;

/**
 * Claude rejects images whose longest side exceeds 2000px in many-image
 * requests with: "An image in the conversation exceeds the dimension limit
 * for many-image requests (2000px)." Since a session may accumulate images
 * across turns, we always bound every inbound image to this cap — even on
 * single-image turns — so we never poison a session for later turns.
 */
const MAX_IMAGE_DIM = 2000;

/** Cap on images per turn. Arbitrary — tune if it becomes an issue. */
const MAX_IMAGES = 8;

/**
 * Aggregate byte cap on inline-image content per turn. Claude's request
 * limit is 32 MB total — without this, 8 max-size images alone could push
 * a single turn over the wire limit before any session history is even
 * considered. Skip any image whose addition would put us over.
 */
const MAX_INLINE_BYTES_PER_TURN = 18_000_000;

export type InlineImage = {
  mediaType: string;
  /** Base64-encoded bytes, ready to drop into a Claude content block. */
  base64: string;
  /** Original source path, for logging + dedup keying. */
  sourcePath: string;
  /** Converted/downscaled file passed to CLIs that accept image paths. */
  preparedPath: string;
};

/**
 * Turn a set of filesystem paths into Claude-ready image content blocks.
 * Paths that don't exist, are too big, or are an unsupported format after
 * conversion attempts are skipped with a log line — callers get back only
 * the ones that succeeded. Duplicate paths are deduped.
 */
export function prepareInlineImages(paths: string[], cacheDir: string): InlineImage[] {
  if (paths.length === 0) return [];
  const seen = new Set<string>();
  const out: InlineImage[] = [];
  let totalBytes = 0;
  for (const raw of paths) {
    if (out.length >= MAX_IMAGES) {
      log.warn("inline-images", "cap reached, skipping remaining", { max: MAX_IMAGES });
      break;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    const prepared = prepareOne(raw, cacheDir);
    if (!prepared) continue;
    // base64 size ≈ data length; use it directly so we don't have to decode.
    const projected = totalBytes + prepared.base64.length;
    if (projected > MAX_INLINE_BYTES_PER_TURN) {
      log.warn("inline-images", "aggregate byte cap reached, skipping remaining", {
        cap: MAX_INLINE_BYTES_PER_TURN,
        total_so_far: totalBytes,
        next_image_bytes: prepared.base64.length,
      });
      break;
    }
    totalBytes = projected;
    out.push(prepared);
  }
  return out;
}

function prepareOne(path: string, cacheDir: string): InlineImage | null {
  if (!existsSync(path)) {
    log.warn("inline-images", "skip missing", { path });
    return null;
  }
  const ext = extname(path).toLowerCase();
  let effectivePath = path;
  let mediaType = SUPPORTED[ext] ?? null;

  if (!mediaType && CONVERTIBLE.has(ext)) {
    const converted = convertToJpeg(path, cacheDir);
    if (!converted) return null;
    effectivePath = converted;
    mediaType = "image/jpeg";
  }
  if (!mediaType) {
    log.warn("inline-images", "skip unsupported format", { path, ext });
    return null;
  }

  const bounded = enforceMaxDim(effectivePath, cacheDir);
  if (bounded && bounded !== effectivePath) {
    effectivePath = bounded;
    mediaType = "image/jpeg";
  }

  const size = statSync(effectivePath).size;
  if (size > MAX_BYTES_PER_IMAGE) {
    log.warn("inline-images", "skip oversize", {
      path: effectivePath,
      bytes: size,
      cap: MAX_BYTES_PER_IMAGE,
    });
    return null;
  }
  try {
    const bytes = readFileSync(effectivePath);
    return {
      mediaType,
      base64: bytes.toString("base64"),
      sourcePath: path,
      preparedPath: effectivePath,
    };
  } catch (err) {
    log.warn("inline-images", "read failed", {
      path: effectivePath,
      err: String(err).slice(0, 200),
    });
    return null;
  }
}

/**
 * Bound an image's longest side to MAX_IMAGE_DIM. Returns the original path
 * if it's already within the cap (or we can't read its dimensions — fail
 * open so we don't reject usable images). Returns a new cached jpeg path if
 * we resized. Cached by basename + dim so repeated turns on the same source
 * don't re-run sips.
 */
function enforceMaxDim(sourcePath: string, cacheDir: string): string | null {
  const dims = readDimensions(sourcePath);
  if (!dims) return sourcePath;
  if (dims.width <= MAX_IMAGE_DIM && dims.height <= MAX_IMAGE_DIM) return sourcePath;

  const base = sourcePath.split("/").pop() ?? "image";
  const outPath = join(cacheDir, `${base}.cap${MAX_IMAGE_DIM}.jpg`);
  if (existsSync(outPath)) return outPath;
  try {
    const res = spawnSync(
      "sips",
      ["-Z", String(MAX_IMAGE_DIM), "-s", "format", "jpeg", sourcePath, "--out", outPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    if (res.status !== 0) {
      log.warn("inline-images", "sips downscale failed", {
        path: sourcePath,
        stderr: String(res.stderr ?? "").slice(0, 200),
      });
      return sourcePath;
    }
    return existsSync(outPath) ? outPath : sourcePath;
  } catch (err) {
    log.warn("inline-images", "sips downscale exec failed", {
      path: sourcePath,
      err: String(err).slice(0, 200),
    });
    return sourcePath;
  }
}

function readDimensions(path: string): { width: number; height: number } | null {
  try {
    const res = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.status !== 0) return null;
    const out = String(res.stdout ?? "");
    const w = out.match(/pixelWidth:\s*(\d+)/);
    const h = out.match(/pixelHeight:\s*(\d+)/);
    if (!w || !h) return null;
    return { width: Number(w[1]), height: Number(h[1]) };
  } catch {
    return null;
  }
}

/**
 * Convert an unsupported source image to JPEG in the cache dir. Returns the
 * output path on success or null if sips wasn't available / conversion failed.
 * Cached by source filename so repeated inbounds on the same file don't
 * re-run the conversion every turn.
 */
function convertToJpeg(sourcePath: string, cacheDir: string): string | null {
  const base = sourcePath.split("/").pop() ?? "image";
  const outPath = join(cacheDir, `${base}.inline.jpg`);
  if (existsSync(outPath)) return outPath;
  try {
    const res = spawnSync("sips", ["-s", "format", "jpeg", sourcePath, "--out", outPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (res.status !== 0) {
      log.warn("inline-images", "sips conversion failed", {
        path: sourcePath,
        stderr: String(res.stderr ?? "").slice(0, 200),
      });
      return null;
    }
    return existsSync(outPath) ? outPath : null;
  } catch (err) {
    log.warn("inline-images", "sips exec failed", {
      path: sourcePath,
      err: String(err).slice(0, 200),
    });
    return null;
  }
}
