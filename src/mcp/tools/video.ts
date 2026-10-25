import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { dispatchOrRun } from "../../background/dispatch.ts";
import { analyzeVideoFile } from "../../media/video-analyze.ts";
import { describeWatch, watchVideoLocally } from "../../media/video-watch.ts";
import { assertPathSafe } from "../../util/path-safety.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const AnalyzeVideoInput = z.object({
  file_path: z
    .string()
    .describe(
      "Absolute path to a video file (typically under received-videos/ in this session's sandbox).",
    ),
  prompt: z
    .string()
    .optional()
    .describe(
      "Optional question or instruction, e.g. 'What does the person say?' or 'Describe the last 5 seconds'. Defaults to a general description.",
    ),
  dense: z
    .boolean()
    .optional()
    .describe(
      "Sample up to 81 frames instead of 36: for form checks, fast motion or a moment you need to find exactly.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Hosted video model, only when you need one: an OpenRouter slug such as google/gemini-3.5-flash (needs credit). Omit to watch it yourself.",
    ),
  async: z
    .boolean()
    .optional()
    .describe(
      "Run in background. Watching locally takes seconds, so only pass true for very long videos (several minutes); the result then arrives as sheet paths to Read.",
    ),
});

/**
 * Claude has no video input, so it watches the way a person skims: frames
 * sampled across the clip on contact sheets it reads as images, plus a local
 * transcript of the audio. Nothing hosted, so nothing prepaid to run out (the
 * hosted path refused 30 videos and voice notes in one week when its balance
 * fell under its floor). A hosted video model is still reachable by naming
 * one. Received iMessage videos live under the sandbox's `received-videos/`
 * dir after copyReceivedAttachments runs.
 */
export function videoTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "analyze_video",
      description:
        "Watch a video: returns its frames on contact sheets (images you look at yourself) plus a transcript of what is said. Use when someone sends a video or you need to check one you made — the built-in Read tool can't open video. Takes a few seconds. Pass dense:true for motion or exact moments.",
      inputSchema: AnalyzeVideoInput,
      handler: async (args) => {
        try {
          assertPathSafe(args.file_path);
        } catch (err) {
          return {
            content: [{ type: "text", text: (err as Error).message }],
            isError: true,
          };
        }
        if (!existsSync(args.file_path)) {
          return {
            content: [
              {
                type: "text",
                text: `File not found: ${args.file_path}. If the user just sent a video, the attachment may still be downloading — retry in a few seconds.`,
              },
            ],
            isError: true,
          };
        }
        if (args.async === true) {
          return dispatchOrRun("analyze_video", args as Record<string, unknown>, ctx);
        }
        if (args.model?.includes("/")) {
          const text = await analyzeVideoFile(
            { filePath: args.file_path, prompt: args.prompt, model: args.model },
            ctx.config,
          );
          return { content: [{ type: "text", text }] };
        }
        const watched = await watchVideoLocally(args.file_path, ctx.config, {
          dense: args.dense === true,
        });
        return {
          content: [
            { type: "text", text: describeWatch(watched, args.prompt) },
            ...watched.sheets.map((s) => ({
              type: "image" as const,
              data: readFileSync(s.path).toString("base64"),
              mimeType: "image/jpeg",
            })),
          ],
        };
      },
    },
  ];
}
