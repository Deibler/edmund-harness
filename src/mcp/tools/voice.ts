import { z } from "zod";
import { dispatchOrRun } from "../../background/dispatch.ts";
import { transcribeMediaFile } from "../../media/transcribe.ts";
import { assertPathSafe } from "../../util/path-safety.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const SttInput = z.object({
  file_path: z
    .string()
    .describe(
      "Absolute path to an audio OR video file (.caf, .m4a, .mp3, .mov, .mp4, …). For video, the audio track is extracted automatically.",
    ),
  async: z
    .boolean()
    .optional()
    .describe(
      "Run in background. Transcription can be slow for long media; pass true for any file >1 minute.",
    ),
});

/**
 * Speech-to-text only. Text-to-speech lives in the generation toolset
 * (OpenRouter-backed `generate_audio`) — keeping TTS on one provider means
 * a single quota hit can't break the voice-memo flow.
 */
export function voiceTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "transcribe_audio",
      description:
        "Transcribe speech from an audio or video file. Inbound voice notes and short videos are usually auto-transcribed into the envelope already — use this for media that arrived without a transcript, for long clips (async:true), or to re-check exact wording.",
      inputSchema: SttInput,
      handler: async (args) => {
        try {
          assertPathSafe(args.file_path);
        } catch (err) {
          return {
            content: [{ type: "text", text: (err as Error).message }],
            isError: true,
          };
        }
        if (args.async === true) {
          return dispatchOrRun("transcribe_audio", args as Record<string, unknown>, ctx);
        }
        const text = await transcribeMediaFile(args.file_path, ctx.config);
        return { content: [{ type: "text", text: text || "(no speech detected)" }] };
      },
    },
  ];
}
