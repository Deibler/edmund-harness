import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Config } from "../config/config.ts";
import * as gemini from "../tools/gemini-http.ts";
import * as openrouter from "../tools/openrouter-http.ts";

/**
 * Backend-agnostic "watch this video" — the brains behind the analyze_video
 * tool. OpenRouter (the one live key) is primary: Gemini models there take
 * inline base64 video. The direct Gemini File API remains as fallback for
 * setups with only a Gemini key.
 *
 * Inline base64 means the request body carries the whole file, so oversized
 * inputs are first re-encoded to an analysis proxy (low bitrate, ≤640px —
 * video models sample ~1 fps, so comprehension survives compression that
 * would be unacceptable for a human viewer).
 */

const DEFAULT_ANALYSIS_MODEL = "google/gemini-3.5-flash";

const DEFAULT_PROMPT =
  "Describe this video in detail. Include any spoken words, on-screen text, notable actions, and overall context. If the subject is ambiguous, say so rather than guessing.";

/** Max bytes we'll inline into one chat request (base64 inflates ~1.37×). */
const INLINE_MAX_BYTES = 18 * 1024 * 1024;

/** Analysis-proxy budget — comfortably under the inline cap even after a
 *  slightly-over-target encode. */
const PROXY_TARGET_BYTES = 14 * 1024 * 1024;

export type AnalyzeArgs = {
  filePath: string;
  prompt?: string;
  /** Model override: an OpenRouter slug ("google/gemini-3.5-flash") when
   *  routing via OpenRouter, or a bare Gemini id on the direct fallback. */
  model?: string;
};

export function hasVideoAnalysisBackend(config: Config): boolean {
  return Boolean(config.keys.openrouter || config.keys.gemini);
}

export async function analyzeVideoFile(args: AnalyzeArgs, config: Config): Promise<string> {
  if (!existsSync(args.filePath)) throw new Error(`file not found: ${args.filePath}`);
  if (config.keys.openrouter) {
    const inlinePath = await ensureInlineable(args.filePath);
    return openrouter.analyzeVideo({
      apiKey: config.keys.openrouter,
      filePath: inlinePath,
      model: args.model?.includes("/") ? args.model : DEFAULT_ANALYSIS_MODEL,
      prompt: args.prompt ?? DEFAULT_PROMPT,
    });
  }
  if (config.keys.gemini) {
    return gemini.analyzeVideo({
      filePath: args.filePath,
      prompt: args.prompt,
      model: args.model,
    });
  }
  throw new Error("no video analysis backend (need keys.openrouter or keys.gemini)");
}

/**
 * Return a path that fits the inline cap in a container the chat API takes:
 * the original when already small enough, otherwise a cached low-bitrate
 * proxy. Unknown containers (.avi/.mkv) always go through the proxy encode.
 */
async function ensureInlineable(filePath: string): Promise<string> {
  const knownMime = openrouter.videoMimeForPath(filePath) !== null;
  if (knownMime && statSync(filePath).size <= INLINE_MAX_BYTES) return filePath;

  const cacheDir = join(dirname(filePath), ".analyze-proxy");
  mkdirSync(cacheDir, { recursive: true });
  const outPath = join(cacheDir, `${basename(filePath, extname(filePath))}-proxy.mp4`);
  if (existsSync(outPath) && statSync(outPath).size <= INLINE_MAX_BYTES) return outPath;

  const probeDuration = await durationSeconds(filePath);
  // Fit the byte budget; no quality floor — models sample sparse frames, so
  // even ~150 kbps at 640px stays legible for comprehension.
  const totalKbps = probeDuration
    ? Math.max(120, Math.floor((PROXY_TARGET_BYTES * 8 * 0.93) / probeDuration / 1000) - 48)
    : 900;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        filePath,
        "-vf",
        "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-b:v",
        `${totalKbps}k`,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "48k",
        "-ac",
        "1",
        "-movflags",
        "+faststart",
        outPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 && existsSync(outPath)
        ? resolve()
        : reject(
            new Error(`analysis proxy encode failed (${code}): ${stderr.trim().slice(0, 200)}`),
          ),
    );
  });
  const size = statSync(outPath).size;
  if (size > INLINE_MAX_BYTES) {
    throw new Error(
      `video too long to inline even as a proxy (${Math.round(size / 1024 / 1024)} MB) — trim a segment with ffmpeg and analyze that`,
    );
  }
  console.log(
    `[video-analyze] proxy ${basename(filePath)} → ${Math.round(size / 1024 / 1024)}MB @${totalKbps}k for analysis`,
  );
  return outPath;
}

function durationSeconds(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (c) => {
      out += c.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const d = Number.parseFloat(out.trim());
      resolve(Number.isFinite(d) && d > 0 ? d : null);
    });
  });
}
