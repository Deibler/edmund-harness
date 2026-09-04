import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "../config/config.ts";
import { isAudioPath, isVideoPath } from "../media/media-kind.ts";
import {
  AUTO_TRANSCRIBE_MAX_DURATION_S,
  sttBackend,
  transcribeMediaFile,
} from "../media/transcribe.ts";
import { type VideoProbe, probeVideo } from "../media/video-probe.ts";

/**
 * Pre-enrich inbound media so Claude sees substance alongside the file path,
 * not just an opaque filename:
 *
 *  - audio → "[voice transcript: …]" (exactly the old behavior)
 *  - video → ffprobe metadata (duration/dimensions/codecs/size) AND a
 *    transcript of its audio track, so "watch this!" arrives with what was
 *    said already in context. Longer than 10 min ⇒ metadata only (the model
 *    can transcribe_audio async if it cares).
 *
 * Runs before the envelope is built. Failures are swallowed per-attachment:
 * the model can still call `transcribe_audio` / `analyze_video` manually.
 */
export type InboundMediaEnrichment = {
  /** Speech transcripts keyed by ORIGINAL attachment path (audio + video). */
  transcripts: Map<string, string>;
  /** ffprobe results keyed by original attachment path (video only). */
  probes: Map<string, VideoProbe>;
};

export async function enrichInboundMedia(
  paths: string[],
  config: Config,
): Promise<InboundMediaEnrichment> {
  const transcripts = new Map<string, string>();
  const probes = new Map<string, VideoProbe>();
  const backend = sttBackend(config);

  await Promise.all(
    paths.map(async (p) => {
      if (!existsSync(p)) return;
      const isVideo = isVideoPath(p);
      const isAudio = isAudioPath(p);
      if (!isVideo && !isAudio) return;

      let probe: VideoProbe | null = null;
      if (isVideo) {
        probe = await probeVideo(p);
        if (probe) probes.set(p, probe);
      }

      if (!backend) return;
      // Videos: skip STT when there's provably nothing to hear, and cap the
      // auto pre-pass at 10 min so a movie-length file doesn't stall the turn.
      if (isVideo && probe && !probe.hasAudio) return;
      if (isVideo && probe?.durationS && probe.durationS > AUTO_TRANSCRIBE_MAX_DURATION_S) return;
      try {
        const transcript = await transcribeMediaFile(p, config);
        if (transcript.trim()) transcripts.set(p, transcript.trim());
      } catch (err) {
        console.warn(`[transcribe] ${basename(p)}: ${(err as Error).message}`);
      }
    }),
  );
  return { transcripts, probes };
}
