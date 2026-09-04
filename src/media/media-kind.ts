import { extname } from "node:path";

/**
 * Single source of truth for classifying media files by extension.
 *
 * Before this existed the answer to "is this a video?" differed across five
 * files — worst consequence: `.mp4` was treated as AUDIO (uploaded whole to
 * Whisper) while a bare `.mov` in a group chat was dropped at the mention
 * gate because only "audio" got the transcript-deferral benefit. Buckets
 * here mirror persona/media-paths.ts (the sandbox archiver).
 */

const AUDIO_EXTS = new Set([".caf", ".m4a", ".mp3", ".wav", ".flac", ".ogg", ".aac", ".amr"]);
const VIDEO_EXTS = new Set([".mov", ".mp4", ".m4v", ".mpeg", ".mpg", ".webm", ".avi", ".mkv"]);

export function isAudioPath(p: string): boolean {
  return AUDIO_EXTS.has(extname(p).toLowerCase());
}

export function isVideoPath(p: string): boolean {
  return VIDEO_EXTS.has(extname(p).toLowerCase());
}

/** Media that may carry speech worth transcribing — audio files, plus any
 *  video container (the audio track gets extracted first). */
export function isTranscribableMedia(p: string): boolean {
  return isAudioPath(p) || isVideoPath(p);
}
