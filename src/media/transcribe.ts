import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
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
 * Backend order: local whisper.cpp first when its model file and binary are
 * present ([tools] local_stt_model, whisper_cli), then OpenRouter when a key
 * is configured, then OpenAI Whisper as the legacy fallback. A failure on one
 * backend falls through to the next. Local comes first because the hosted
 * one is prepaid: when the balance fell under its $0.50 floor (2026-10-18 to
 * 10-25) voice notes and videos stopped being understood at all, and a local
 * pass over a 9 s note takes under a second on this Mac. `stt_model` picks
 * the hosted model — a slash means an OpenRouter slug; the legacy bare
 * "whisper-1" maps to the verified OpenRouter default.
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
  | { kind: "local"; bin: string; model: string }
  | { kind: "openrouter"; apiKey: string; model: string }
  | { kind: "openai"; model: string };

/** The local whisper.cpp backend, or null when its model or binary is absent. */
export function localSttBackend(config: Config): Extract<SttBackend, { kind: "local" }> | null {
  const configured = config.tools.local_stt_model?.trim();
  if (!configured) return null;
  const model = isAbsolute(configured) ? configured : join(config.paths.data_dir, configured);
  if (!existsSync(model)) return null;
  const wanted = config.tools.whisper_cli?.trim() || "whisper-cli";
  const bin = isAbsolute(wanted)
    ? existsSync(wanted)
      ? wanted
      : null
    : (Bun.which(wanted) ?? Bun.which(wanted, { PATH: "/opt/homebrew/bin:/usr/local/bin" }));
  return bin ? { kind: "local", bin, model } : null;
}

/** Every configured backend, in the order they are tried. */
export function sttBackends(config: Config): SttBackend[] {
  const out: SttBackend[] = [];
  const local = localSttBackend(config);
  if (local) out.push(local);
  if (config.keys.openrouter) {
    const configured = config.tools.stt_model;
    const model = configured.includes("/") ? configured : OPENROUTER_STT_DEFAULT;
    out.push({ kind: "openrouter", apiKey: config.keys.openrouter, model });
  }
  if (config.keys.openai) out.push({ kind: "openai", model: config.tools.stt_model });
  return out;
}

export function sttBackend(config: Config): SttBackend | null {
  return sttBackends(config)[0] ?? null;
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
  const backends = sttBackends(config);
  if (backends.length === 0) {
    throw new Error(
      "no STT backend configured (need [tools] local_stt_model + whisper-cli, keys.openrouter or keys.openai)",
    );
  }
  if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);

  const cacheDir = join(config.paths.data_dir, "media", "transcode");
  mkdirSync(cacheDir, { recursive: true });
  let lastError: Error | null = null;
  for (const backend of backends) {
    try {
      return await transcribeWith(backend, filePath, cacheDir);
    } catch (err) {
      lastError = err as Error;
      console.warn(
        `[transcribe] ${backend.kind} failed for ${basename(filePath)}: ${lastError.message.slice(0, 200)}`,
      );
    }
  }
  throw lastError ?? new Error("transcription failed");
}

async function transcribeWith(
  backend: SttBackend,
  filePath: string,
  cacheDir: string,
): Promise<string> {
  if (backend.kind === "local") return transcribeLocally(backend, filePath, cacheDir);
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

/**
 * whisper.cpp over a 16 kHz mono WAV. Returns "" for silence or a video with
 * no audio track. The model loads per call (about 0.3 s warm; the first call
 * after boot also compiles Metal kernels, about 10 s).
 */
async function transcribeLocally(
  backend: Extract<SttBackend, { kind: "local" }>,
  filePath: string,
  cacheDir: string,
): Promise<string> {
  if (isVideoPath(filePath)) {
    const probe = await probeVideo(filePath);
    if (probe === null) throw new Error("ffprobe/ffmpeg unavailable — cannot extract audio track");
    if (!probe.hasAudio) return "";
  }
  const wav = await convertToWav(filePath, cacheDir);
  const stdout = await runProcess(
    backend.bin,
    ["-m", backend.model, "-f", wav, "-nt", "-np", "-t", "4"],
    180_000,
  );
  return cleanWhisperText(stdout);
}

/** whisper.cpp marks non-speech with bracketed or parenthesised tags
 *  ("[BLANK_AUDIO]", "(music)"); a transcript of only those is silence. */
export function cleanWhisperText(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/\[[^\]]*\]|\((?:music|silence|applause|laughter|inaudible|blank_audio)[^)]*\)/gi, ""))
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function convertToWav(srcPath: string, cacheDir: string): Promise<string> {
  const outPath = join(cacheDir, `${basename(srcPath, extname(srcPath))}.stt.wav`);
  if (existsSync(outPath)) return Promise.resolve(outPath);
  return runProcess(
    "ffmpeg",
    ["-v", "error", "-y", "-i", srcPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outPath],
    120_000,
  ).then(() => {
    if (!existsSync(outPath)) throw new Error("ffmpeg wrote no wav");
    return outPath;
  });
}

function runProcess(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${basename(bin)} exit ${code}: ${stderr.trim().slice(-300)}`));
    });
  });
}
