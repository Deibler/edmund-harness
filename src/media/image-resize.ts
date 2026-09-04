import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".heic", ".webp", ".tiff"]);
const DEFAULT_MAX_DIM = 1800;
const DEFAULT_MAX_BYTES = 2_500_000; // ~2.5MB; iMessage over LTE hates >3MB

/**
 * Shrink oversized images before sending via iMessage. Uses macOS's built-in
 * `sips` (no sharp dep). Skipped for non-images and for files already within
 * both the pixel and byte thresholds.
 *
 * Returns the path to use for sending — the original if no resize needed,
 * or a new path in the resize cache.
 */
export async function maybeResizeImage(
  inputPath: string,
  maxDim = DEFAULT_MAX_DIM,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<string> {
  if (!isImage(inputPath) || !existsSync(inputPath)) return inputPath;
  const stat = statSync(inputPath);
  if (stat.size <= maxBytes) {
    // Quick check — if file is already small, don't even spawn sips to inspect dimensions.
    return inputPath;
  }

  const cacheDir = join(dirname(inputPath), ".resized");
  mkdirSync(cacheDir, { recursive: true });
  const out = join(cacheDir, `${basename(inputPath, extname(inputPath))}-${maxDim}.jpg`);
  if (existsSync(out) && statSync(out).size <= maxBytes) return out;

  try {
    await runSips([
      "-Z",
      String(maxDim),
      "--setProperty",
      "format",
      "jpeg",
      inputPath,
      "--out",
      out,
    ]);
    return existsSync(out) ? out : inputPath;
  } catch (err) {
    console.warn(`[image-resize] ${basename(inputPath)}: ${(err as Error).message}`);
    return inputPath;
  }
}

function isImage(p: string): boolean {
  return IMAGE_EXTS.has(extname(p).toLowerCase());
}

function runSips(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sips", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`sips exit ${code}: ${stderr.trim()}`)),
    );
  });
}
