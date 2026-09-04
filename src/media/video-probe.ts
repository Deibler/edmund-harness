import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/**
 * ffprobe wrapper — the cheap (~50ms) metadata read that lets the envelope
 * describe an inbound video instead of showing a bare file path, and lets
 * the outbound guard decide whether a video needs transcoding before it
 * rides iMessage.
 *
 * Everything degrades to null when ffprobe is missing or the file is not a
 * real video — callers treat null as "no metadata available", never as an
 * error.
 */

export type VideoProbe = {
  /** Container duration in seconds (fractional), null if unparseable. */
  durationS: number | null;
  width: number | null;
  height: number | null;
  /** e.g. "h264", "hevc", "vp9". */
  videoCodec: string | null;
  /** e.g. "aac", "opus". Null when the file has no audio track. */
  audioCodec: string | null;
  hasAudio: boolean;
  sizeBytes: number;
  fps: number | null;
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
};

type FfprobeOutput = {
  format?: { duration?: string };
  streams?: FfprobeStream[];
};

let ffprobeAvailable: boolean | null = null;

/** One `ffprobe -version` spawn per process lifetime; everything downstream
 *  degrades gracefully when the binary is absent. */
async function hasFfprobe(): Promise<boolean> {
  if (ffprobeAvailable !== null) return ffprobeAvailable;
  ffprobeAvailable = await new Promise<boolean>((resolve) => {
    const proc = spawn("ffprobe", ["-version"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
  return ffprobeAvailable;
}

export async function probeVideo(path: string): Promise<VideoProbe | null> {
  if (!existsSync(path)) return null;
  if (!(await hasFfprobe())) return null;
  const json = await new Promise<string | null>((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    proc.stdout.on("data", (c) => {
      out += c.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => resolve(code === 0 ? out : null));
  });
  if (!json) return null;
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(json) as FfprobeOutput;
  } catch {
    return null;
  }
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  const durationRaw = Number.parseFloat(parsed.format?.duration ?? "");
  return {
    durationS: Number.isFinite(durationRaw) ? durationRaw : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: audio !== undefined,
    sizeBytes: statSync(path).size,
    fps: parseFps(video?.avg_frame_rate),
  };
}

export function parseFps(avgFrameRate: string | undefined): number | null {
  if (!avgFrameRate) return null;
  const [num, den] = avgFrameRate.split("/").map((n) => Number.parseFloat(n));
  if (!num || !den || !Number.isFinite(num) || !Number.isFinite(den)) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 10) / 10 : null;
}

/** One-line human summary for the envelope's Attachments annotation:
 *  "0:14 · 1080×1920 · h264+aac · 18.2 MB". Omits whatever the probe
 *  couldn't determine. */
export function describeVideo(p: VideoProbe): string {
  const parts: string[] = [];
  if (p.durationS !== null) parts.push(formatDuration(p.durationS));
  if (p.width && p.height) parts.push(`${p.width}×${p.height}`);
  const codecs = [p.videoCodec, p.audioCodec].filter(Boolean).join("+");
  if (codecs) parts.push(codecs);
  parts.push(formatBytes(p.sizeBytes));
  return parts.join(" · ");
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
