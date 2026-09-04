import { writeFileSync } from "node:fs";
import type { Config } from "../config/config.ts";
import { beginCharge } from "../credits/billing.ts";
import * as intSettings from "../integrations/settings.ts";
import { recordModelOutcome } from "../media/model-scorecard.ts";
import { transcribeMediaFile } from "../media/transcribe.ts";
import { analyzeVideoFile } from "../media/video-analyze.ts";
import { indexGeneratedMedia } from "../memory/index-artifact.ts";
import { generatedPath } from "../persona/media-paths.ts";
import type { SessionKey } from "../sessions/key.ts";
import * as or from "../tools/openrouter-http.ts";
import {
  execCfContent,
  execCfJson,
  execCfLinks,
  execCfMarkdown,
  execCfPdf,
  execCfScrape,
  execCfScreenshot,
  execCfSnapshot,
  makeCfClient,
} from "./cf-execute.ts";

/**
 * Generic registry of tools that can run in the background.
 *
 * Each executor receives args (already validated by Zod upstream) and a
 * minimal context (config, sandbox, session key, data dir). It returns the
 * primary output path (if any) and a short summary that the wake-up event
 * will surface to the model.
 *
 * Tools NOT in this registry can't be backgrounded. Fast tools (memory
 * search, history lookups, reminder CRUD) don't need it — they'd just add
 * wake-up latency for no gain.
 */

type BgToolContext = {
  config: Config;
  sandboxPath: string;
  sessionKey: string;
  dataDir: string;
};

type BgToolResult = {
  /** Absolute path of the primary output file, or null for text-only results. */
  resultPath: string | null;
  /** Summary text surfaced to the model in the wake-up envelope. */
  summary: string;
};

export type BgToolExecutor = (
  args: Record<string, unknown>,
  ctx: BgToolContext,
) => Promise<BgToolResult>;

// ─── executors ───────────────────────────────────────────────────────────────

function cfClient(ctx: BgToolContext): {
  client: ReturnType<typeof makeCfClient>;
  accountId: string;
} {
  const { api_token, account_id } = intSettings.cloudflare(ctx.config);
  if (!api_token || !account_id) {
    throw new Error(
      "Cloudflare credentials missing (intSettings.cloudflare(config).api_token / account_id)",
    );
  }
  return { client: makeCfClient(api_token), accountId: account_id };
}

const cfExec =
  (fn: typeof execCfScreenshot): BgToolExecutor =>
  async (args, ctx) => {
    const { client, accountId } = cfClient(ctx);
    const r = await fn(args, ctx.sandboxPath, client, accountId);
    return { resultPath: r.resultPath, summary: r.summary };
  };

async function execGenImage(
  args: Record<string, unknown>,
  ctx: BgToolContext,
): Promise<BgToolResult> {
  // Who pays: the person's own wallet key, or the house key. Refuses (with a
  // model-facing message) when their credit is gone. See src/credits/billing.ts.
  const charge = await beginCharge({ ctx, kind: "image" });
  const apiKey = charge.apiKey;
  const cfg = ctx.config.openrouter;
  const refs = args.reference_images as string[] | undefined;
  const hasRefs = Array.isArray(refs) && refs.length > 0;
  const model =
    (args.model as string | undefined) ??
    (hasRefs ? cfg.default_edit_model : cfg.default_image_model);
  const prompt = args.prompt as string;
  const file = generatedPath(ctx.sandboxPath, "images", "png", prompt);
  let result: or.ImageResult;
  try {
    result = await or.generateImage({
      apiKey,
      model,
      prompt,
      referenceImages: refs,
      aspectRatio: args.aspect_ratio as string | undefined,
      imageSize: args.image_size as string | undefined,
    });
  } catch (err) {
    // A 402 is about money, not the model — it must not dent the scorecard.
    const credit = await charge.explainFailure(err);
    if (credit) throw new Error(credit);
    // Record the failure to the global model scorecard so future generations
    // (any session) can avoid models that don't deliver, then surface it.
    recordModelOutcome({
      dataDir: ctx.dataDir,
      kind: "image",
      model,
      outcome: "failed",
      detail: (err as Error).message.slice(0, 300),
      sessionKey: ctx.sessionKey,
    });
    throw new Error(`image generation failed (model: ${model}): ${(err as Error).message}`);
  }
  writeFileSync(file, result.pngBytes);
  // Generation succeeded — the model produced a usable image. User sentiment
  // (liked / rejected) is recorded separately when Edmund sees the reaction.
  recordModelOutcome({
    dataDir: ctx.dataDir,
    kind: "image",
    model,
    outcome: "generated",
    sessionKey: ctx.sessionKey,
  });
  void indexGeneratedMedia({
    config: ctx.config,
    sessionKey: ctx.sessionKey as SessionKey,
    kind: "image",
    filePath: file,
    prompt,
    model,
  });
  return {
    resultPath: file,
    summary: `Image generated: ${file}\nModel: ${model}\nSend with send_attachment("${file}") to deliver.${await charge.footer({ model, generationId: result.generationId ?? null })}`,
  };
}

async function execGenVideo(
  args: Record<string, unknown>,
  ctx: BgToolContext,
): Promise<BgToolResult> {
  const cfg = ctx.config.openrouter;
  const model = (args.model as string | undefined) ?? cfg.default_video_model;
  // Video is priced up front: a clip the balance cannot cover is refused
  // before any render time is burned.
  const charge = await beginCharge({
    ctx,
    kind: "video",
    video: { model, durationS: args.duration as number | undefined },
  });
  const apiKey = charge.apiKey;
  const prompt = args.prompt as string;
  const file = generatedPath(ctx.sandboxPath, "videos", "mp4", prompt);
  const frames = args.frame_images as
    | Array<{ path: string; frame_type: "first_frame" | "last_frame" }>
    | undefined;
  let bytes: Uint8Array;
  let jobId: string | null = null;
  try {
    const video = await or.generateVideo({
      apiKey,
      model,
      prompt,
      resolution: args.resolution as string | undefined,
      aspectRatio: args.aspect_ratio as string | undefined,
      duration: args.duration as number | undefined,
      generateAudio: args.generate_audio as boolean | undefined,
      frameImages: frames?.map((f) => ({ path: f.path, frameType: f.frame_type })),
      referenceImages: args.reference_images as string[] | undefined,
      pollIntervalMs: cfg.video_poll_interval_s * 1000,
      maxWaitMs: cfg.video_max_wait_s * 1000,
    });
    bytes = video.bytes;
    jobId = video.jobId;
  } catch (err) {
    const credit = await charge.explainFailure(err);
    if (credit) throw new Error(credit);
    recordModelOutcome({
      dataDir: ctx.dataDir,
      kind: "video",
      model,
      outcome: "failed",
      detail: (err as Error).message.slice(0, 300),
      sessionKey: ctx.sessionKey,
    });
    throw new Error(`video generation failed (model: ${model}): ${(err as Error).message}`);
  }
  writeFileSync(file, bytes);
  recordModelOutcome({
    dataDir: ctx.dataDir,
    kind: "video",
    model,
    outcome: "generated",
    sessionKey: ctx.sessionKey,
  });
  void indexGeneratedMedia({
    config: ctx.config,
    sessionKey: ctx.sessionKey as SessionKey,
    kind: "video",
    filePath: file,
    prompt,
    model,
  });
  return {
    resultPath: file,
    summary: `Video generated: ${file}\nModel: ${model}\nSend with send_attachment("${file}") to deliver.${await charge.footer({ model, generationId: jobId })}`,
  };
}

async function execGenAudio(
  args: Record<string, unknown>,
  ctx: BgToolContext,
): Promise<BgToolResult> {
  const charge = await beginCharge({ ctx, kind: "audio" });
  const apiKey = charge.apiKey;
  const cfg = ctx.config.openrouter;
  const model = (args.model as string | undefined) ?? cfg.default_audio_model;
  const voice = (args.voice as string | undefined) ?? cfg.default_audio_voice;
  const format = ((args.format as string | undefined) ?? "mp3") as
    | "mp3"
    | "wav"
    | "flac"
    | "opus"
    | "pcm16";
  const text = args.text as string;
  const file = generatedPath(ctx.sandboxPath, "voice-memos", format, text.slice(0, 30));
  let result: Awaited<ReturnType<typeof or.generateAudio>>;
  try {
    result = await or.generateAudio({ apiKey, model, text, voice, format });
  } catch (err) {
    const credit = await charge.explainFailure(err);
    if (credit) throw new Error(credit);
    recordModelOutcome({
      dataDir: ctx.dataDir,
      kind: "audio",
      model,
      outcome: "failed",
      detail: (err as Error).message.slice(0, 300),
      sessionKey: ctx.sessionKey,
    });
    throw new Error(`audio generation failed (model: ${model}): ${(err as Error).message}`);
  }
  writeFileSync(file, result.bytes);
  recordModelOutcome({
    dataDir: ctx.dataDir,
    kind: "audio",
    model,
    outcome: "generated",
    sessionKey: ctx.sessionKey,
  });
  void indexGeneratedMedia({
    config: ctx.config,
    sessionKey: ctx.sessionKey as SessionKey,
    kind: "audio",
    filePath: file,
    prompt: text,
    model,
  });
  return {
    resultPath: file,
    summary: `Audio generated: ${file}\nModel: ${model}, voice: ${voice}\nSend with send_attachment("${file}") to deliver.${await charge.footer({ model, generationId: result.generationId ?? null })}`,
  };
}

async function execTranscribe(
  args: Record<string, unknown>,
  ctx: BgToolContext,
): Promise<BgToolResult> {
  const filePath = args.file_path as string;
  const text = await transcribeMediaFile(filePath, ctx.config);
  return {
    resultPath: null,
    summary: `Transcription of ${filePath}:\n\n${text || "(no speech detected)"}`,
  };
}

async function execAnalyzeVideo(
  args: Record<string, unknown>,
  ctx: BgToolContext,
): Promise<BgToolResult> {
  const filePath = args.file_path as string;
  const text = await analyzeVideoFile(
    {
      filePath,
      prompt: args.prompt as string | undefined,
      model: args.model as string | undefined,
    },
    ctx.config,
  );
  return {
    resultPath: null,
    summary: `Video analysis of ${filePath}:\n\n${text}`,
  };
}

async function execWebFetch(
  args: Record<string, unknown>,
  ctx: BgToolContext,
): Promise<BgToolResult> {
  const { webFetch } = await import("../web/fetch.ts");
  const url = args.url as string;
  const result = await webFetch(url, {
    mode: (args.mode as "markdown" | "text" | undefined) ?? "markdown",
    maxChars: args.max_chars as number | undefined,
  });
  const header = result.title ? `# ${result.title}\n${result.url}\n\n` : `${result.url}\n\n`;
  const truncatedNote = result.truncated ? "\n\n[Content truncated]" : "";
  // Save to sandbox for reference
  const slug = new URL(url).hostname.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const dir = join(ctx.sandboxPath, "web-fetch");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ts}-${slug}.md`);
  writeFileSync(file, `${header}${result.content}`);
  return {
    resultPath: file,
    summary: `Fetched ${url}\nSaved to: ${file}\n\n${header}${result.content}${truncatedNote}`,
  };
}

// ─── registry ────────────────────────────────────────────────────────────────

export const BG_EXECUTORS: Record<string, BgToolExecutor> = {
  cf_screenshot: cfExec(execCfScreenshot),
  cf_pdf: cfExec(execCfPdf),
  cf_markdown: cfExec(execCfMarkdown),
  cf_content: cfExec(execCfContent),
  cf_snapshot: cfExec(execCfSnapshot),
  cf_links: cfExec(execCfLinks),
  cf_scrape: cfExec(execCfScrape),
  cf_json: cfExec(execCfJson),
  generate_image: execGenImage,
  generate_video: execGenVideo,
  generate_audio: execGenAudio,
  transcribe_audio: execTranscribe,
  analyze_video: execAnalyzeVideo,
  web_fetch: execWebFetch,
};

export function isBackgroundable(toolName: string): boolean {
  return toolName in BG_EXECUTORS;
}
