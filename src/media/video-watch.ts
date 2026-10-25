import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Config } from "../config/config.ts";
import { transcribeMediaFile } from "./transcribe.ts";
import { type VideoProbe, probeVideo } from "./video-probe.ts";

/**
 * Watching a video with the model's own eyes: frames sampled evenly across
 * the clip, tiled into 3x3 contact sheets the model reads as images, plus a
 * local transcript of the audio track. No hosted video model, so no prepaid
 * balance to run out: from 2026-10-18 to 10-25 the hosted path refused 30
 * videos and voice notes when its balance fell under its $1.00 floor.
 *
 * Sampling is sparse (about one frame a second, capped), which is enough for
 * "what's happening here" and "what does the sign say". Fast motion between
 * frames is lost; `dense` raises the cap for form checks and the like.
 */

const SHEET_COLS = 3;
const SHEET_ROWS = 3;
const PER_SHEET = SHEET_COLS * SHEET_ROWS;
const MIN_FRAMES = 6;
const MAX_FRAMES = 36;
const MAX_FRAMES_DENSE = 81;
/** Long edge of one frame. Three across stays within the 1568 px the model
 *  sees without downscaling. */
const FRAME_LONG_EDGE = 512;

export type ContactSheet = { path: string; times: number[] };

export type WatchedVideo = {
  probe: VideoProbe | null;
  sheets: ContactSheet[];
  transcript: string | null;
  transcriptError: string | null;
};

/** Evenly spaced frame times for a clip, about one a second up to the cap. */
export function framePlan(durationS: number | null, dense = false): number[] {
  const cap = dense ? MAX_FRAMES_DENSE : MAX_FRAMES;
  if (!durationS || durationS <= 0) return Array.from({ length: PER_SHEET }, (_, i) => i);
  const count = Math.max(MIN_FRAMES, Math.min(cap, Math.round(durationS)));
  const step = durationS / count;
  return Array.from({ length: count }, (_, i) => Math.round(i * step * 10) / 10);
}

export async function watchVideoLocally(
  filePath: string,
  config: Config,
  opts: { dense?: boolean } = {},
): Promise<WatchedVideo> {
  if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  const probe = await probeVideo(filePath);
  if (probe === null) throw new Error("ffprobe/ffmpeg unavailable — cannot read the video");
  const times = framePlan(probe.durationS, opts.dense);
  const outDir = join(
    dirname(filePath),
    ".watch",
    `${basename(filePath, extname(filePath))}${opts.dense ? "-dense" : ""}`,
  );
  const sheets = await writeContactSheets(filePath, outDir, times, probe.durationS);

  let transcript: string | null = null;
  let transcriptError: string | null = null;
  if (probe.hasAudio) {
    try {
      transcript = await transcribeMediaFile(filePath, config);
    } catch (err) {
      transcriptError = (err as Error).message.slice(0, 200);
    }
  }
  return { probe, sheets, transcript, transcriptError };
}

async function writeContactSheets(
  filePath: string,
  outDir: string,
  times: number[],
  durationS: number | null,
): Promise<ContactSheet[]> {
  const expected = Math.ceil(times.length / PER_SHEET);
  const existing = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => /^sheet-\d+\.jpg$/.test(f))
    : [];
  if (existing.length !== expected) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const rate = durationS && durationS > 0 ? times.length / durationS : 1;
    const scale = `scale='if(gte(iw,ih),${FRAME_LONG_EDGE},-2)':'if(gte(iw,ih),-2,${FRAME_LONG_EDGE})'`;
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      filePath,
      "-vf",
      `fps=${rate.toFixed(4)},${scale},tile=${SHEET_COLS}x${SHEET_ROWS}:padding=4:color=white`,
      "-frames:v",
      String(expected),
      "-q:v",
      "4",
      join(outDir, "sheet-%02d.jpg"),
    ]);
  }
  const files = readdirSync(outDir)
    .filter((f) => /^sheet-\d+\.jpg$/.test(f))
    .sort();
  if (files.length === 0) throw new Error("ffmpeg produced no frames from this video");
  return files.map((f, i) => ({
    path: join(outDir, f),
    times: times.slice(i * PER_SHEET, (i + 1) * PER_SHEET),
  }));
}

function clock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

/** The text that goes beside the sheets: what the model is looking at, in
 *  what order, and what was said. */
export function describeWatch(w: WatchedVideo, question?: string): string {
  const p = w.probe;
  const lines: string[] = [];
  const dims = p?.width && p.height ? `${p.width}x${p.height}` : "unknown size";
  const dur = p?.durationS ? `${p.durationS.toFixed(1)} s` : "unknown length";
  const frames = w.sheets.reduce((n, s) => n + s.times.length, 0);
  lines.push(
    `Video: ${dur}, ${dims}. ${frames} frames sampled evenly, on ${w.sheets.length} contact sheet${w.sheets.length === 1 ? "" : "s"} of ${SHEET_COLS}x${SHEET_ROWS}, read left to right, top to bottom. Motion between frames is not visible; ask for a dense pass if it matters.`,
  );
  w.sheets.forEach((s, i) => {
    lines.push(`Sheet ${i + 1}: frames at ${s.times.map(clock).join(", ")}`);
  });
  if (w.transcript !== null) {
    lines.push("", `Audio transcript: ${w.transcript || "(no speech)"}`);
  } else if (w.transcriptError) {
    lines.push("", `Audio transcript unavailable: ${w.transcriptError}`);
  } else {
    lines.push("", "No audio track.");
  }
  if (question) lines.push("", `Question to answer from what you see: ${question}`);
  return lines.join("\n");
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${bin} timed out`));
    }, 120_000);
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${bin} exit ${code}: ${stderr.trim().slice(-300)}`));
    });
  });
}
