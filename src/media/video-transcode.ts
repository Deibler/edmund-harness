import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isVideoPath } from "./media-kind.ts";
import { probeVideo } from "./video-probe.ts";

/**
 * The video sibling of maybeResizeImage: make an outbound video actually
 * deliverable over iMessage before it hits the bridge.
 *
 * Two failure modes this prevents:
 *  - WEIGHT: a raw 4K screen recording or received-videos/ forward is
 *    50-200 MB; huge files stall or die over LTE and burn the send retry
 *    ladder on IMCore timeouts. We target ≤ ~15 MB.
 *  - FORMAT: .webm/.mkv/vp9/av1 render as a generic file bubble (or not at
 *    all) on iOS. iMessage wants H.264/HEVC + AAC in an mp4/mov container.
 *
 * Compatible-and-small files pass through untouched. Transcodes prefer the
 * macOS hardware encoder (h264_videotoolbox — realtime-or-better) and fall
 * back to libx264. Any failure returns the original path: a too-big send
 * that MIGHT fail beats a guard that definitely blocks it.
 */

const DEFAULT_MAX_BYTES = 15_000_000;
/** Longest edge after transcode. 1080p-class is indistinguishable in a
 *  message bubble and keeps bitrate budgets honest. */
const MAX_DIMENSION = 1920;
const COMPATIBLE_CONTAINERS = new Set([".mp4", ".mov", ".m4v"]);
const COMPATIBLE_VIDEO_CODECS = new Set(["h264", "hevc", "mpeg4"]);
const COMPATIBLE_AUDIO_CODECS = new Set(["aac", "mp3", "alac"]);
/** Never let the bitrate math produce mush; floor ≈ readable 720p. */
const MIN_VIDEO_KBPS = 700;
const MAX_VIDEO_KBPS = 8_000;
const AUDIO_KBPS = 128;

export async function maybePrepareVideoForSend(
  inputPath: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<string> {
  if (!isVideoPath(inputPath) || !existsSync(inputPath)) return inputPath;
  const probe = await probeVideo(inputPath);
  if (!probe) return inputPath; // no ffprobe/ffmpeg — nothing we can do

  const containerOk = COMPATIBLE_CONTAINERS.has(extname(inputPath).toLowerCase());
  const codecOk =
    (probe.videoCodec === null || COMPATIBLE_VIDEO_CODECS.has(probe.videoCodec)) &&
    (probe.audioCodec === null || COMPATIBLE_AUDIO_CODECS.has(probe.audioCodec));
  if (containerOk && codecOk && probe.sizeBytes <= maxBytes) return inputPath;

  const cacheDir = join(dirname(inputPath), ".transcoded");
  mkdirSync(cacheDir, { recursive: true });
  const outPath = join(cacheDir, `${basename(inputPath, extname(inputPath))}-imsg.mp4`);
  if (existsSync(outPath) && statSync(outPath).size <= maxBytes) return outPath;

  const videoKbps = targetVideoKbps(probe.durationS, maxBytes);
  const scale = `scale='min(${MAX_DIMENSION},iw)':'min(${MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const common = [
    "-v",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vf",
    scale,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    `${AUDIO_KBPS}k`,
    "-movflags",
    "+faststart",
  ];
  const attempts: string[][] = [
    [...common, "-c:v", "h264_videotoolbox", "-b:v", `${videoKbps}k`, outPath],
    [
      ...common,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      `${videoKbps}k`,
      "-maxrate",
      `${Math.round(videoKbps * 1.4)}k`,
      "-bufsize",
      `${videoKbps * 2}k`,
      outPath,
    ],
  ];
  for (const args of attempts) {
    try {
      await runFfmpeg(args);
      if (existsSync(outPath) && statSync(outPath).size > 0) {
        console.log(
          `[video-transcode] ${basename(inputPath)}: ${Math.round(probe.sizeBytes / 1024 / 1024)}MB ${probe.videoCodec ?? "?"} → ${Math.round(statSync(outPath).size / 1024 / 1024)}MB h264 @${videoKbps}k`,
        );
        return outPath;
      }
    } catch (err) {
      console.warn(`[video-transcode] ${basename(inputPath)}: ${(err as Error).message}`);
    }
  }
  return inputPath;
}

/** Bitrate that fits the byte budget for the clip's duration (minus audio),
 *  clamped to sane bounds. Unknown duration ⇒ a middle-of-the-road 2.5 Mbps. */
export function targetVideoKbps(durationS: number | null, maxBytes = DEFAULT_MAX_BYTES): number {
  if (!durationS || durationS <= 0) return 2_500;
  // 0.93 leaves container overhead headroom.
  const totalKbps = (maxBytes * 8 * 0.93) / durationS / 1000;
  const videoKbps = Math.floor(totalKbps - AUDIO_KBPS);
  return Math.max(MIN_VIDEO_KBPS, Math.min(MAX_VIDEO_KBPS, videoKbps));
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(0, 300)}`)),
    );
  });
}
