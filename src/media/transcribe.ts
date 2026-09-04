import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Config } from "../config/config.ts";
import * as openaiHttp from "../tools/openai-http.ts";
import * as openrouter from "../tools/openrouter-http.ts";
import { isAudioPath, isVideoPath } from "./media-kind.ts";
import { probeVideo } from "./video-probe.ts";

/**
 * Provider-agnostic speech-to-text for ANY media file the harness receives —
 * voice notes, music, and (the reason this module exists) videos, whose audio
 * track is demuxed with ffmpeg before upload.
 *
 * Backend order: OpenRouter when a key is configured (the OpenAI key died
 * with a 401 in 2026-06 and everything else already routes through
 * OpenRouter), OpenAI Whisper as the legacy fallback. `stt_model` in
 * [tools] config picks the model — a slash means an OpenRouter slug;
 * the legacy bare "whisper-1" maps to the verified OpenRouter default.
 */

const OPENROUTER_STT_DEFAULT = "openai/whisper-large-v3"; // verified live 2026-07-30

/** Don't upload more than this much audio in one STT call (base64 inflates
 *  by ~1.37×; the classic Whisper API cap is 25 MB). At the 48 kbps mono
 *  AAC we extract, this is over an hour of speech. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Auto-transcription (the inbound pre-pass) skips media longer than this;
 *  the model can still call transcribe_audio explicitly — async — for a
 *  podcast-length file. */
export const AUTO_TRANSCRIBE_MAX_DURATION_S = 600;

export type SttBackend =
  | { kind: "openrouter"; apiKey: string; model: string }
  | { kind: "openai"; model: string };

export function sttBackend(config: Config): SttBackend | null {
  if (config.keys.openrouter) {
    const configured = config.tools.stt_model;
    const model = configured.includes("/") ? configured : OPENROUTER_STT_DEFAULT;
    return { kind: "openrouter", apiKey: config.keys.openrouter, model };
  }
  if (config.keys.openai) return { kind: "openai", model: config.tools.stt_model };
  return null;
}

let ffmpegAvailable: boolean | null = null;

async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  ffmpegAvailable = await new Promise<boolean>((resolve) => {
    const proc = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
  return ffmpegAvailable;
}

/**
 * Transcribe one media file. Returns the transcript ("" when there is no
 * speech / no audio track). Throws on real failures (missing key, API
 * error, conversion failure) so callers can decide whether to surface or
 * swallow.
 *
 * Conversion cache lives under `data/media/transcode` (same place the old
 * caf→m4a converter used), keyed by basename — attachment basenames carry
 * an iMessage GUID so collisions aren't a practical concern.
 */
export async function transcribeMediaFile(filePath: string, config: Config): Promise<string> {
  const backend = sttBackend(config);
  if (!backend) throw new Error("no STT backend configured (need keys.openrouter or keys.openai)");
  if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);

  const cacheDir = join(config.paths.data_dir, "media", "transcode");
  mkdirSync(cacheDir, { recursive: true });
  const uploadPath = await prepareForStt(filePath, cacheDir);
  if (uploadPath === null) return ""; // video with no audio track

  const size = statSync(uploadPath).size;
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `audio too large for one STT call (${Math.round(size / 1024 / 1024)} MB > ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`,
    );
  }

  if (backend.kind === "openrouter") {
    return openrouter.transcribeAudio({
      apiKey: backend.apiKey,
      filePath: uploadPath,
      model: backend.model,
      // 60s base + generous headroom for long clips; STT latency scales
      // with duration, and the inbound pre-pass already caps duration.
      timeoutMs: 120_000,
    });
  }
  return openaiHttp.transcribeAudio({ filePath: uploadPath, model: backend.model });
}

/**
 * Produce a path in a container the STT endpoint accepts:
 *  - accepted audio (wav/mp3/flac/m4a/ogg/webm/aac) → as-is
 *  - .caf (iMessage voice notes) → m4a via built-in afconvert (no ffmpeg dep)
 *  - video containers → 16 kHz mono AAC track via ffmpeg; null if no audio
 *  - other audio (.amr, …) → m4a via ffmpeg
 */
async function prepareForStt(filePath: string, cacheDir: string): Promise<string | null> {
  const ext = extname(filePath).toLowerCase();
  if (openrouter.sttAcceptsFormat(ext) && !isVideoPath(filePath)) return filePath;
  if (ext === ".caf") return convertCafToM4a(filePath, cacheDir);

  if (isVideoPath(filePath)) {
    const probe = await probeVideo(filePath);
    // Probe unavailable (no ffprobe) ⇒ ffmpeg is absent too — can't demux.
    if (probe === null) throw new Error("ffprobe/ffmpeg unavailable — cannot extract audio track");
    if (!probe.hasAudio) return null;
    return extractAudioTrack(filePath, cacheDir);
  }

  if (isAudioPath(filePath)) {
    if (!(await hasFfmpeg())) throw new Error(`no converter for ${ext} (ffmpeg unavailable)`);
    return extractAudioTrack(filePath, cacheDir);
  }
  throw new Error(`not a transcribable media file: ${filePath}`);
}

/** Demux/convert to speech-grade mono AAC. 16 kHz/48 kbps keeps a 10-minute
 *  clip near 3.5 MB — well inside the upload cap. */
function extractAudioTrack(srcPath: string, cacheDir: string): Promise<string> {
  const outPath = join(cacheDir, `${basename(srcPath, extname(srcPath))}.stt.m4a`);
  if (existsSync(outPath)) return Promise.resolve(outPath);
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        srcPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "aac",
        "-b:a",
        "48k",
        outPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 && existsSync(outPath)
        ? resolve(outPath)
        : reject(new Error(`ffmpeg audio extract exit ${code}: ${stderr.trim().slice(0, 300)}`)),
    );
  });
}

function convertCafToM4a(cafPath: string, cacheDir: string): Promise<string> {
  const outPath = join(cacheDir, `${basename(cafPath, ".caf")}.m4a`);
  if (existsSync(outPath)) return Promise.resolve(outPath);
  return new Promise((resolve, reject) => {
    const proc = spawn("afconvert", ["-f", "m4af", "-d", "aac", cafPath, outPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve(outPath) : reject(new Error(`afconvert exit ${code}: ${stderr.trim()}`)),
    );
  });
}
