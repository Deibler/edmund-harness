import { existsSync } from "node:fs";
import { z } from "zod";
import { dispatchOrRun } from "../../background/dispatch.ts";
import { analyzeVideoFile, hasVideoAnalysisBackend } from "../../media/video-analyze.ts";
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
  model: z
    .string()
    .optional()
    .describe(
      "Model override. Omit for the default (google/gemini-3.5-flash via OpenRouter); a slash slug picks another OpenRouter video-capable model.",
    ),
  async: z
    .boolean()
    .optional()
    .describe(
      "Run in background. Video analysis can take 30-90s depending on clip length; pass true for anything longer than a few seconds so the session lock releases.",
    ),
});

/**
 * Claude has no built-in video vision, so we delegate to a video-capable
 * model — Gemini via OpenRouter inline video (primary; oversized files get
 * an ffmpeg analysis proxy first), or the direct Gemini File API when only
 * that key is configured. Received iMessage videos live under the sandbox's
 * `received-videos/` dir after copyReceivedAttachments runs.
 */
export function videoTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "analyze_video",
      description:
        "Analyze a video file (describe content, transcribe speech, answer questions about it) via Gemini. Use when the user sends a video and you need to understand what's in it — the built-in Read tool can't process video. For clips longer than a few seconds, pass async:true.",
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
        if (!hasVideoAnalysisBackend(ctx.config)) {
          return {
            content: [
              {
                type: "text",
                text: "No video analysis backend configured (need config.keys.openrouter or keys.gemini). Ask the user to set one before analyzing videos.",
              },
            ],
            isError: true,
          };
        }
        if (args.async === true) {
          return dispatchOrRun("analyze_video", args as Record<string, unknown>, ctx);
        }
        const text = await analyzeVideoFile(
          { filePath: args.file_path, prompt: args.prompt, model: args.model },
          ctx.config,
        );
        return { content: [{ type: "text", text }] };
      },
    },
  ];
}
