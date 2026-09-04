import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Path helpers for per-session media. Keeps every artifact scoped to the
 * conversation's sandbox so the model (and a human reviewer) can look back
 * at everything produced or received for this thread in one place.
 *
 * Layout under sandbox/<id>/:
 *   images/           generated + edited images
 *   voice-memos/      generated TTS audio
 *   videos/           generated videos
 *   received-images/  inbound images (copied from Messages/Attachments)
 *   received-videos/  inbound videos
 *   received-audio/   inbound voice notes + audio files
 *   received-files/   anything else the user sent (PDFs, docs, etc.)
 */

type MediaKind =
  | "images"
  | "voice-memos"
  | "videos"
  | "received-images"
  | "received-videos"
  | "received-audio"
  | "received-files";

function mediaSubdir(sandboxPath: string, kind: MediaKind): string {
  const dir = join(sandboxPath, kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function generatedPath(
  sandboxPath: string,
  kind: "images" | "voice-memos" | "videos",
  extension: string,
  label?: string,
): string {
  const dir = mediaSubdir(sandboxPath, kind);
  const stamp = filenameStamp(new Date());
  const tag = label ? `_${slugify(label)}` : "";
  const ext = extension.startsWith(".") ? extension : `.${extension}`;
  return join(dir, `${stamp}${tag}${ext}`);
}

function receivedBucket(sourcePath: string): MediaKind {
  const ext = extname(sourcePath).toLowerCase().slice(1);
  if (IMAGE_EXT.has(ext)) return "received-images";
  if (VIDEO_EXT.has(ext)) return "received-videos";
  if (AUDIO_EXT.has(ext)) return "received-audio";
  return "received-files";
}

export function receivedPath(sandboxPath: string, sourcePath: string, messageDate: Date): string {
  const bucket = receivedBucket(sourcePath);
  const dir = mediaSubdir(sandboxPath, bucket);
  const stamp = filenameStamp(messageDate);
  // Keep original basename for recognizability, prefix with timestamp for
  // chronological ordering.
  const base = sourcePath.split("/").pop() ?? "attachment";
  return join(dir, `${stamp}_${sanitizeFilename(base)}`);
}

function filenameStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^\w.\-]+/g, "_").slice(0, 120);
}

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "bmp", "tiff"]);
const VIDEO_EXT = new Set(["mov", "mp4", "m4v", "mpeg", "mpg", "webm", "avi", "mkv"]);
const AUDIO_EXT = new Set(["caf", "m4a", "mp3", "wav", "flac", "ogg", "aac", "amr"]);
