import { spawnSync } from "node:child_process";

/**
 * macOS auto-transcribes iMessage voice notes and stashes the text in
 * `attachment.user_info` as a bplist under the "audio-transcription" key.
 * We parse it via the built-in `plutil` — no deps, no API calls.
 *
 * Returns null if no transcript is present (older devices, non-audio
 * attachments, or voice notes still processing on-device).
 */
export function extractAppleTranscript(userInfo: Uint8Array | null | undefined): string | null {
  if (!userInfo || userInfo.length === 0) return null;
  const res = spawnSync("plutil", ["-extract", "audio-transcription", "raw", "-o", "-", "-"], {
    input: Buffer.from(userInfo),
  });
  if (res.status !== 0) return null;
  const text = (res.stdout?.toString("utf8") ?? "").trim();
  return text.length > 0 ? text : null;
}
