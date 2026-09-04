import { z } from "zod";
import { dispatchOrRun } from "../../background/dispatch.ts";
import {
  type MediaKind,
  type ModelStat,
  modelScorecard,
  recordModelOutcome,
} from "../../media/model-scorecard.ts";
import * as or from "../../tools/openrouter-http.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const asyncField = z
  .boolean()
  .optional()
  .describe(
    "Run in background (recommended for this slow tool). When true, returns a job id immediately; session lock releases; a wake-up event fires when done so you can send_attachment the result. ALWAYS pass true unless you have a specific reason to block the session.",
  );

/**
 * OpenRouter-backed generation tools. Design notes:
 *
 * - **Model discovery first.** The model is expected to call `list_*_models`
 *   with a `max_price_usd` filter and pick one that fits the task (character
 *   consistency, style reference, speed, etc). The harness has per-modality
 *   price ceilings in config — any model above those is hidden from listing.
 * - **Reference images come from the sandbox.** Callers pass absolute paths
 *   to files under `received-images/` (or wherever) and the HTTP layer inlines
 *   them as base64 data URLs. No special staging step.
 * - **Outputs land in the sandbox archive** (images/, videos/, voice-memos/),
 *   dated filenames. Model must follow with `send_attachment(path)` to
 *   actually deliver.
 */

const ListInput = z.object({
  max_price_usd: z
    .number()
    .positive()
    .optional()
    .describe(
      "Hard cap — only return models at or below this price. Leave unset to use the config default.",
    ),
  query: z.string().optional().describe("Filter by keyword — matches id, name, and description."),
});

const ImageInput = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("What to draw / edit. Be specific about style, subject, composition."),
  model: z
    .string()
    .optional()
    .describe(
      "OpenRouter model id (e.g. 'google/gemini-3.1-flash-image-preview'). Omit for the configured default.",
    ),
  reference_images: z
    .array(z.string())
    .optional()
    .describe(
      "Absolute paths (or https URLs) of reference images. Use for image-to-image edits, character refs, style guidance. Paths from received-images/ work directly.",
    ),
  aspect_ratio: z
    .string()
    .optional()
    .describe("e.g. '1:1', '16:9', '9:16', '4:3', '21:9'. Model-dependent."),
  image_size: z.string().optional().describe("e.g. '1K', '2K', '4K'. Model-dependent."),
  async: asyncField,
});

const VideoInput = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  resolution: z.string().optional().describe("'720p', '1080p', etc."),
  aspect_ratio: z.string().optional().describe("'16:9', '9:16', '1:1', etc."),
  duration: z.number().int().positive().optional().describe("Seconds. Model-dependent cap."),
  generate_audio: z.boolean().optional().describe("Add synced audio if model supports it."),
  frame_images: z
    .array(
      z.object({
        path: z.string().describe("Absolute path or https URL."),
        frame_type: z.enum(["first_frame", "last_frame"]),
      }),
    )
    .optional()
    .describe("For image-to-video: first/last frame anchors."),
  reference_images: z
    .array(z.string())
    .optional()
    .describe("For reference-to-video: style/character guidance."),
  async: asyncField,
});

const AudioInput = z.object({
  text: z.string().min(1),
  model: z.string().optional(),
  voice: z
    .string()
    .optional()
    .describe("e.g. alloy / echo / fable / onyx / nova / shimmer. Model-dependent."),
  format: z.enum(["mp3", "wav", "flac", "opus", "pcm16"]).optional(),
  async: asyncField,
});

const KindField = z
  .enum(["image", "video", "audio"])
  .describe("Which generation modality the model is for.");

const ScorecardInput = z.object({
  kind: KindField.optional().describe("Filter to one modality. Omit to see all."),
});

const RateInput = z.object({
  kind: KindField,
  model: z
    .string()
    .describe("The exact model id that produced the output (as shown in the generation summary)."),
  reaction: z
    .enum(["liked", "rejected"])
    .describe(
      "'liked' = the user reacted positively / kept it. 'rejected' = the user disliked it, asked for a redo, or complained.",
    ),
  note: z.string().optional().describe("Optional short note on why (feeds the scorecard detail)."),
});

export function generationTools(ctx: ToolContext): ToolDef[] {
  const getKey = (): string => {
    const key = ctx.config.keys.openrouter;
    if (!key) throw new Error("config.keys.openrouter is not set");
    return key;
  };
  const cfg = ctx.config.openrouter;

  return [
    {
      name: "list_image_models",
      description:
        "Discover OpenRouter image-generation models that fit your budget. Returns id, name, description, and price. Call this before `generate_image` when picking a model (character consistency, style reference, editing, etc). Prices hidden above the configured cap.",
      inputSchema: ListInput,
      handler: async (args) => {
        const cap = Math.min(
          args.max_price_usd ?? cfg.max_image_price_usd,
          cfg.max_image_price_usd,
        );
        const models = await or.listImageModels(getKey());
        const filtered = filterByPriceAndQuery(models, cap, args.query);
        return text(renderModels(filtered, "image", `USD/image, cap=$${cap}`));
      },
    },
    {
      name: "list_video_models",
      description:
        "Discover OpenRouter video-generation models that fit your budget. Returns id, name, description, per-second price, supported resolutions + aspect ratios. Call before `generate_video`.",
      inputSchema: ListInput,
      handler: async (args) => {
        const cap = Math.min(
          args.max_price_usd ?? cfg.max_video_price_per_second_usd,
          cfg.max_video_price_per_second_usd,
        );
        const models = await or.listVideoModels(getKey());
        const filtered = filterByPriceAndQuery(models, cap, args.query);
        return text(renderModels(filtered, "video", `USD/second, cap=$${cap}`));
      },
    },
    {
      name: "list_audio_models",
      description:
        "Discover OpenRouter audio-OUTPUT models. Covers TTS voices (OpenAI GPT Audio, GPT Audio Mini) AND music/singing models (Google Lyria 3 Pro/Clip). Pick based on the task: TTS for spoken memos; Lyria for singing/music. Primary price is USD/song for Lyria, ≈USD/minute for token-streamed TTS — full pricing breakdown included so you can see real costs.",
      inputSchema: ListInput,
      handler: async (args) => {
        const cap = Math.min(
          args.max_price_usd ?? cfg.max_audio_price_usd,
          cfg.max_audio_price_usd,
        );
        const models = await or.listAudioOutputModels(getKey());
        const filtered = filterByPriceAndQuery(models, cap, args.query);
        return text(renderModels(filtered, "audio", `primary-price cap=$${cap}`));
      },
    },

    {
      name: "generate_image",
      description:
        "Generate OR EDIT an image via OpenRouter. Check `model_scorecard` first to pick a model with a good track record (success rate + user likes); then `list_image_models` for price. Pass `reference_images` (absolute paths, incl. received-images/) to do image-to-image, character consistency, or style transfer. When references are present, the harness auto-routes to an edit-optimized model (default: FLUX.2 Pro) that preserves faces/subjects far better than a text-to-image model would. Output saved to sandbox/images/ with a dated filename. Takes 20-90s — ALWAYS pass async:true so the session stays responsive; you'll wake up with the path and can send_attachment. When you see how the user reacts, call `rate_model_output`.",
      inputSchema: ImageInput,
      handler: (args) => dispatchOrRun("generate_image", args, ctx),
    },
    {
      name: "generate_video",
      description:
        "Generate a video via OpenRouter. Check `model_scorecard` first (video is slow + pricey — pick a proven model), then `list_video_models` for price. Supports text-to-video, image-to-video (pass `frame_images`), and reference-to-video (pass `reference_images`). Output mp4 saved to sandbox/videos/. Takes 1-10 MINUTES — ALWAYS pass async:true. You'll wake up with the path when rendering finishes; then send_attachment. When you see how the user reacts, call `rate_model_output`.",
      inputSchema: VideoInput,
      handler: (args) => dispatchOrRun("generate_video", args, ctx),
    },
    {
      name: "generate_audio",
      description:
        "Generate spoken audio (text → speech) via OpenRouter. Output saved to sandbox/voice-memos/. Takes 15-60s for TTS, longer for music models — ALWAYS pass async:true. Default model + voice from config; override with `list_audio_models` first.",
      inputSchema: AudioInput,
      handler: (args) => dispatchOrRun("generate_audio", args, ctx),
    },
    {
      name: "model_scorecard",
      description:
        "GLOBAL track record of generative models across ALL chats — check this BEFORE generate_image/generate_video to pick a model that actually delivers and that users have liked. Shows, per model: how many times it generated successfully vs failed, how many outputs the user liked vs rejected, when it was last used, and a composite quality score (best first). New/unproven models rank near neutral so they still get tried. Pair with list_*_models (which has prices) to balance cost vs proven quality.",
      inputSchema: ScorecardInput,
      handler: (args) => {
        const stats = modelScorecard({ dataDir: ctx.dataDir, kind: args.kind as MediaKind });
        return text(renderScorecard(stats, args.kind));
      },
    },
    {
      name: "rate_model_output",
      description:
        "Record how the user reacted to a generated image/video/audio so future model choices (in ANY chat) learn from it. Call this whenever you can tell the user liked the result (kept it, praised it, sent it on) or didn't (asked for a redo, complained, rejected it). Use the exact model id from the generation summary. This is what makes model_scorecard's 'liked vs rejected' column meaningful — be diligent about it.",
      inputSchema: RateInput,
      handler: (args) => {
        recordModelOutcome({
          dataDir: ctx.dataDir,
          kind: args.kind as MediaKind,
          model: args.model,
          outcome: args.reaction as "liked" | "rejected",
          detail: args.note,
          sessionKey: ctx.sessionKey,
        });
        return text(`Recorded: ${args.model} (${args.kind}) → ${args.reaction}.`);
      },
    },
  ];
}

function renderScorecard(stats: ModelStat[], kind: string | undefined): string {
  const scope = kind ? `${kind} ` : "";
  if (stats.length === 0) {
    return `No ${scope}generation history yet — nothing recorded. Pick via list_*_models for now; the scorecard fills in as you generate and rate outputs.`;
  }
  const lines = [`${scope}model scorecard (${stats.length} model(s), best first):`];
  for (const s of stats) {
    const attempts = s.generated + s.failed;
    const succ = `${s.generated}/${attempts} ok (${Math.round(s.successRate * 100)}%)`;
    const sentiment =
      s.approval === null
        ? "no ratings"
        : `${s.liked}👍/${s.rejected}👎 (${Math.round(s.approval * 100)}% liked)`;
    lines.push(`• ${s.model} [${s.kind}] — score ${s.score.toFixed(2)} | ${succ} | ${sentiment}`);
  }
  return lines.join("\n");
}

function filterByPriceAndQuery(
  models: or.ModelSummary[],
  cap: number,
  query: string | undefined,
): or.ModelSummary[] {
  const q = query?.toLowerCase().trim();
  // Estimate per-output-unit cost in the cap's unit. Most image models are
  // token-streamed — their `price.amount` is $/M output tokens, which is
  // unit-incompatible with a $/image cap. Multiply by ~15k output tokens
  // per image (empirical: Nano Banana 2 at $3/M → $0.045/image matches
  // observed cost; Pro at $12/M → $0.18/image). Per-image-priced models
  // compare directly.
  const estimatedCost = (m: or.ModelSummary): number => {
    const p = m.price;
    if (!p) return 0;
    const unit = p.unit.toLowerCase();
    if (
      unit.includes("image") ||
      unit.includes("song") ||
      unit.includes("request") ||
      unit.includes("second") ||
      unit.includes("min")
    ) {
      return p.amount;
    }
    if (unit.includes("token")) {
      const comp = m.pricing.completion;
      if (comp !== undefined && comp > 0) return comp * 0.015;
    }
    return p.amount;
  };
  const filtered = models.filter((m) => {
    if (estimatedCost(m) > cap) return false;
    if (q && !`${m.id} ${m.name} ${m.description}`.toLowerCase().includes(q)) return false;
    return true;
  });
  // Sort cheapest-first. For token-streamed image models, the headline
  // `price.amount` often reflects a tiny input-image-token field (e.g.
  // Gemini 3 Pro Image shows $0.000002/image from its input-image pricing,
  // masking the real $12/M output-token cost that actually drives a $0.14
  // generation). So prefer `pricing.completion` when it's non-zero — that's
  // the dominant cost for image / audio output models. Fall back to
  // `price.amount` otherwise. Zero/negative/missing sort last (OpenRouter
  // uses sentinels like -1e6 for variable/auto-routed models).
  const effectiveCost = (m: or.ModelSummary): number => {
    const comp = m.pricing.completion;
    if (comp !== undefined && comp > 0) return comp;
    const p = m.price?.amount;
    if (p === undefined || p <= 0) return Number.POSITIVE_INFINITY;
    return p;
  };
  return filtered.sort((a, b) => effectiveCost(a) - effectiveCost(b));
}

function renderModels(models: or.ModelSummary[], kind: string, capNote: string): string {
  if (models.length === 0) return `no ${kind} models match (${capNote})`;
  const lines = [`${models.length} ${kind} model(s) (${capNote}):`];
  for (const m of models.slice(0, 30)) {
    const primary = m.price ? `$${m.price.amount.toFixed(4)} ${m.price.unit}` : "price n/a";
    let line = `• ${m.id} — ${primary}`;
    const full = renderFullPricing(m.pricing);
    if (full) line += `\n    pricing: ${full}`;
    const desc = m.description.replace(/\s+/g, " ").trim();
    if (desc) line += `\n    ${desc.slice(0, 200)}`;
    if (m.supportedAspectRatios?.length)
      line += `\n    ratios: ${m.supportedAspectRatios.join(", ")}`;
    if (m.supportedResolutions?.length) line += `\n    res: ${m.supportedResolutions.join(", ")}`;
    lines.push(line);
  }
  return lines.join("\n");
}

function renderFullPricing(p: or.FullPricing): string {
  const parts: string[] = [];
  if (p.prompt !== undefined) parts.push(`$${p.prompt.toFixed(2)}/M in`);
  if (p.completion !== undefined) parts.push(`$${p.completion.toFixed(2)}/M out`);
  if (p.audio !== undefined) parts.push(`$${p.audio.toFixed(2)}/M audio`);
  if (p.image !== undefined) parts.push(`$${p.image.toFixed(4)}/image`);
  if (p.request !== undefined) parts.push(`$${p.request.toFixed(4)}/req`);
  for (const [k, v] of Object.entries(p.raw ?? {})) parts.push(`${k}=$${v}`);
  return parts.join(", ");
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}
