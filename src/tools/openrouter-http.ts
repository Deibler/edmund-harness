import { readFileSync } from "node:fs";
import { extname } from "node:path";

/**
 * Thin OpenRouter client for multimodal generation.
 *
 * Three generators:
 *   • generateImage  — /chat/completions with `modalities: ["image", "text"]`
 *                      Supports image-to-image by attaching references as
 *                      image_url content parts. Output comes back as a base64
 *                      data URL in message.images[].
 *   • generateVideo  — async /api/v1/videos with polling. Returns a local mp4.
 *                      Supports text-to-video, image-to-video (frame_images),
 *                      and reference-to-video (input_references).
 *   • generateAudio  — streaming /chat/completions with modalities
 *                      ["text","audio"]. Concatenates base64 audio chunks.
 *
 * Plus three listers (image / video / audio) for model discovery with a
 * per-modality price cap enforced by the caller.
 */

const BASE_URL = "https://openrouter.ai/api/v1";

type Price = {
  /** Dollars per output unit (image, second of video, minute of audio). */
  amount: number;
  /** Human-readable unit, for display. */
  unit: string;
};

/** Everything the /models endpoint tells us about price so the model can pick. */
export type FullPricing = {
  /** $/M input text tokens. */
  prompt?: number;
  /** $/M output text tokens. */
  completion?: number;
  /** $/M audio tokens (input or output depending on model). */
  audio?: number;
  /** $/image output. */
  image?: number;
  /** $/M image tokens. */
  image_tokens?: number;
  /** $/request (some models are flat-rate). */
  request?: number;
  /** Raw object for anything non-standard (per_song, per_clip, etc). */
  raw?: Record<string, string>;
};

export type ModelSummary = {
  id: string;
  name: string;
  description: string;
  /** Primary per-output price, if we can pick one. For filtering. */
  price: Price | null;
  /** Full pricing breakdown — shown verbatim so the model sees real costs. */
  pricing: FullPricing;
  supportedAspectRatios?: string[];
  supportedSizes?: string[];
  supportedResolutions?: string[];
};

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/edmund-harness",
    "X-Title": "edmund-harness",
  };
}

// ---------- Model discovery ----------

export async function listImageModels(apiKey: string): Promise<ModelSummary[]> {
  const res = await fetch(`${BASE_URL}/models?output_modalities=image`, {
    headers: headers(apiKey),
  });
  if (!res.ok) throw new Error(`listImageModels ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data: RawChatModel[] };
  return body.data.map(summarizeChatModel);
}

export async function listVideoModels(apiKey: string): Promise<ModelSummary[]> {
  const res = await fetch(`${BASE_URL}/videos/models`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(`listVideoModels ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data: RawVideoModel[] };
  return body.data.map(summarizeVideoModel);
}

export async function listAudioOutputModels(apiKey: string): Promise<ModelSummary[]> {
  const res = await fetch(`${BASE_URL}/models?output_modalities=audio`, {
    headers: headers(apiKey),
  });
  if (!res.ok) throw new Error(`listAudioOutputModels ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data: RawChatModel[] };
  return body.data.map(summarizeChatModel);
}

// ---------- Speech-to-text ----------

/** Audio container formats the /audio/transcriptions endpoint accepts
 *  directly (per the OpenRouter STT schema). Anything else must be
 *  converted before upload — see src/media/transcribe.ts. */
const STT_FORMATS = new Set(["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"]);

export function sttAcceptsFormat(ext: string): boolean {
  return STT_FORMATS.has(ext.replace(/^\./, "").toLowerCase());
}

export type TranscribeArgs = {
  apiKey: string;
  /** Path to an audio file in an STT_FORMATS container. */
  filePath: string;
  /** OpenRouter model slug, e.g. "openai/whisper-large-v3" (verified live)
   *  or "mistralai/voxtral-mini-transcribe". */
  model: string;
  /** ISO-639-1 hint; omit to let the model auto-detect. */
  language?: string;
  timeoutMs?: number;
};

/**
 * Speech-to-text via `POST /audio/transcriptions` — the JSON/base64 shape
 * (same call the constellation voice pipeline uses in production), not the
 * OpenAI-style multipart upload.
 */
export async function transcribeAudio(args: TranscribeArgs): Promise<string> {
  const ext = extname(args.filePath).replace(/^\./, "").toLowerCase();
  if (!sttAcceptsFormat(ext)) {
    throw new Error(`transcribeAudio: unsupported container .${ext} (convert first)`);
  }
  const bytes = readFileSync(args.filePath);
  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: headers(args.apiKey),
    body: JSON.stringify({
      input_audio: { data: bytes.toString("base64"), format: ext },
      model: args.model,
      ...(args.language ? { language: args.language } : {}),
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`audio.transcriptions ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

// ---------- Video understanding ----------

export type AnalyzeVideoArgs = {
  apiKey: string;
  /** Path to an mp4/mov/webm the target model can ingest inline. Callers are
   *  responsible for size (base64 inflates ~1.37×) — see video-analyze.ts. */
  filePath: string;
  /** Chat model slug with `video` in its input modalities. */
  model: string;
  prompt: string;
  timeoutMs?: number;
};

const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
};

export function videoMimeForPath(p: string): string | null {
  return VIDEO_MIME[extname(p).toLowerCase()] ?? null;
}

/**
 * Watch a video with a multimodal chat model via a `video_url` data URL —
 * verified live against google/gemini-3.5-flash-lite with both video/mp4
 * and video/quicktime payloads. This replaces the direct Gemini File API
 * path as the primary backend (that key went invalid; OpenRouter is the
 * one key everything else already uses).
 */
export async function analyzeVideo(args: AnalyzeVideoArgs): Promise<string> {
  const mime = videoMimeForPath(args.filePath);
  if (!mime) throw new Error(`analyzeVideo: unsupported container ${extname(args.filePath)}`);
  const b64 = readFileSync(args.filePath).toString("base64");
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(args.apiKey),
    body: JSON.stringify({
      model: args.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: args.prompt },
            { type: "video_url", video_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? 180_000),
  });
  if (!res.ok) throw new Error(`analyzeVideo ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("analyzeVideo: empty response");
  return text;
}

// ---------- Image generation ----------

export type GenerateImageArgs = {
  apiKey: string;
  model: string;
  prompt: string;
  /** Local paths OR public https URLs. Locals get base64-inlined. */
  referenceImages?: string[];
  aspectRatio?: string;
  imageSize?: string;
};

export type ImageResult = {
  pngBytes: Uint8Array;
  mimeType: string;
  /** OpenRouter's id for this generation — its cost can be read back with
   *  GET /generation?id=… (see src/credits/activity.ts). */
  generationId?: string;
};

export async function generateImage(args: GenerateImageArgs): Promise<ImageResult> {
  const userContent: Array<Record<string, unknown>> = [{ type: "text", text: args.prompt }];
  for (const ref of args.referenceImages ?? []) {
    userContent.push({ type: "image_url", image_url: { url: toImageUrl(ref) } });
  }
  const body: Record<string, unknown> = {
    model: args.model,
    messages: [{ role: "user", content: userContent }],
    modalities: ["image", "text"],
  };
  if (args.aspectRatio || args.imageSize) {
    const image_config: Record<string, string> = {};
    if (args.aspectRatio) image_config.aspect_ratio = args.aspectRatio;
    if (args.imageSize) image_config.image_size = args.imageSize;
    body.image_config = image_config;
  }

  const post = () =>
    fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: headers(args.apiKey),
      body: JSON.stringify(body),
    });
  let res = await post();
  if (!res.ok) {
    const errText = await res.text();
    // Image-only models (the flux.2 family) 404 with "No endpoints found
    // that support the requested output modalities: image, text" — they
    // can't emit the text modality. Retry image-only instead of failing
    // the generation (this killed every edit routed to flux.2-pro, the
    // configured default_edit_model).
    if (res.status === 404 && /output modalities/i.test(errText)) {
      body.modalities = ["image"];
      res = await post();
      if (!res.ok) throw new Error(`generateImage ${res.status}: ${await res.text()}`);
    } else {
      throw new Error(`generateImage ${res.status}: ${errText}`);
    }
  }
  const data = (await res.json()) as ImageCompletionResponse;
  const images = data.choices?.[0]?.message?.images ?? [];
  if (images.length === 0) {
    throw new Error(
      `generateImage: no images in response (text: ${data.choices?.[0]?.message?.content ?? ""})`,
    );
  }
  const first = images[0]!.image_url.url;
  return { ...decodeDataUrl(first), generationId: data.id };
}

// ---------- Video generation (async) ----------

export type GenerateVideoArgs = {
  apiKey: string;
  model: string;
  prompt: string;
  resolution?: string;
  aspectRatio?: string;
  size?: string;
  duration?: number;
  generateAudio?: boolean;
  /** Local paths OR public URLs. First-frame / last-frame images. */
  frameImages?: Array<{ path: string; frameType: "first_frame" | "last_frame" }>;
  /** Local paths OR public URLs. Style / character reference images. */
  referenceImages?: string[];
  pollIntervalMs?: number;
  maxWaitMs?: number;
};

export type VideoResult = {
  bytes: Uint8Array;
  /** The async job's id — OpenRouter's handle on this generation. */
  jobId: string;
};

export async function generateVideo(args: GenerateVideoArgs): Promise<VideoResult> {
  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
  };
  if (args.resolution) body.resolution = args.resolution;
  if (args.aspectRatio) body.aspect_ratio = args.aspectRatio;
  if (args.size) body.size = args.size;
  if (args.duration) body.duration = args.duration;
  if (args.generateAudio !== undefined) body.generate_audio = args.generateAudio;
  if (args.frameImages?.length) {
    body.frame_images = args.frameImages.map((f) => ({
      type: "image_url",
      image_url: { url: toImageUrl(f.path) },
      frame_type: f.frameType,
    }));
  }
  if (args.referenceImages?.length) {
    body.input_references = args.referenceImages.map((p) => ({
      type: "image_url",
      image_url: { url: toImageUrl(p) },
    }));
  }

  const submit = await fetch(`${BASE_URL}/videos`, {
    method: "POST",
    headers: headers(args.apiKey),
    body: JSON.stringify(body),
  });
  if (!submit.ok) throw new Error(`generateVideo submit ${submit.status}: ${await submit.text()}`);
  const job = (await submit.json()) as VideoJob;

  const pollMs = args.pollIntervalMs ?? 20_000;
  const maxMs = args.maxWaitMs ?? 600_000;
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const p = await fetch(job.polling_url, { headers: headers(args.apiKey) });
    if (!p.ok) throw new Error(`generateVideo poll ${p.status}: ${await p.text()}`);
    const status = (await p.json()) as VideoJob;
    if (status.status === "completed") {
      const url = status.unsigned_urls?.[0];
      if (!url) throw new Error("generateVideo: completed but no unsigned_urls");
      const contentRes = await fetch(url, { headers: headers(args.apiKey) });
      if (!contentRes.ok) throw new Error(`generateVideo download ${contentRes.status}`);
      return { bytes: new Uint8Array(await contentRes.arrayBuffer()), jobId: job.id };
    }
    if (status.status === "failed") {
      throw new Error(`generateVideo failed: ${status.error ?? "unknown"}`);
    }
  }
  throw new Error(`generateVideo timed out after ${maxMs}ms`);
}

// ---------- Audio generation ----------

export type GenerateAudioArgs = {
  apiKey: string;
  model: string;
  text: string;
  voice: string;
  format?: string;
};

export async function generateAudio(
  args: GenerateAudioArgs,
): Promise<{ bytes: Uint8Array; format: string; transcript: string; generationId?: string }> {
  const format = args.format ?? "mp3";
  const body = {
    model: args.model,
    // GPT audio models are CHAT models: a bare user message gets ANSWERED,
    // not read — pin them to verbatim TTS with a system frame. Dedicated TTS
    // models (Gemini TTS) treat every message as script, so the frame would
    // be read aloud there; they get the bare text.
    messages: /gpt-audio|4o-audio/.test(args.model)
      ? [
          {
            role: "system",
            content:
              "You are a text-to-speech engine. Speak the user's message aloud verbatim, " +
              "word for word. Never answer it, comment on it, or add or remove anything.",
          },
          { role: "user", content: args.text },
        ]
      : [{ role: "user", content: args.text }],
    modalities: ["text", "audio"],
    audio: { voice: args.voice, format },
    stream: true,
  };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(args.apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`generateAudio ${res.status}: ${await res.text()}`);
  if (!res.body) throw new Error("generateAudio: no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const audioChunks: string[] = [];
  const transcriptChunks: string[] = [];
  let generationId: string | undefined;
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as AudioStreamChunk;
        if (chunk.id && !generationId) generationId = chunk.id;
        // A refused generation still answers 200 and puts the refusal in the
        // stream body. Read it, or the caller writes a 0-byte file and reports
        // a song it never got.
        if (chunk.error) {
          throw new Error(
            `generateAudio ${chunk.error.code ?? ""}: ${chunk.error.message ?? "stream error"}`.trim(),
          );
        }
        const audio = chunk.choices?.[0]?.delta?.audio;
        if (audio?.data) audioChunks.push(audio.data);
        if (audio?.transcript) transcriptChunks.push(audio.transcript);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("generateAudio ")) throw err;
        // ignore malformed lines
      }
    }
  }
  if (audioChunks.length === 0) {
    throw new Error("generateAudio: stream carried no audio");
  }
  const bytes = Buffer.from(audioChunks.join(""), "base64");
  return {
    bytes: new Uint8Array(bytes),
    format,
    transcript: transcriptChunks.join(""),
    generationId,
  };
}

// ---------- Helpers: ModelSummary extraction ----------

type RawChatModel = {
  id: string;
  name: string;
  description?: string;
  pricing?: Record<string, string>;
  architecture?: { output_modalities?: string[] };
};

type RawVideoModel = {
  id: string;
  name: string;
  description?: string;
  pricing_skus?: Record<string, string>;
  supported_aspect_ratios?: string[];
  supported_sizes?: string[];
  supported_resolutions?: string[];
};

function summarizeChatModel(m: RawChatModel): ModelSummary {
  const pricing: FullPricing = {};
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.pricing ?? {})) {
    if (typeof v !== "string") continue;
    const n = Number.parseFloat(v);
    if (Number.isNaN(n)) continue;
    if (k === "prompt") pricing.prompt = n * 1_000_000;
    else if (k === "completion") pricing.completion = n * 1_000_000;
    else if (k === "audio") pricing.audio = n * 1_000_000;
    else if (k === "image") pricing.image = n;
    else if (k === "image_tokens" || k === "input_image_tokens")
      pricing.image_tokens = n * 1_000_000;
    else if (k === "request") pricing.request = n;
    else raw[k] = v;
  }
  if (Object.keys(raw).length > 0) pricing.raw = raw;
  const primary = pickPrimaryPrice(pricing);
  return {
    id: m.id,
    name: m.name,
    description: m.description ?? "",
    price: primary,
    pricing,
  };
}

function pickPrimaryPrice(p: FullPricing): Price | null {
  if (p.image !== undefined) return { amount: p.image, unit: "USD/image" };
  // Audio output = per-million-audio-tokens → rough "per minute" proxy
  // (models that stream TTS output ~1000 tokens/min), not exact.
  if (p.audio !== undefined) return { amount: p.audio / 1000, unit: "USD/min (≈)" };
  // Fallback: completion rate as a speed/cost proxy.
  if (p.completion !== undefined) return { amount: p.completion, unit: "USD/M output tokens" };
  // Per-song / per-clip / per-request paths.
  const raw = p.raw ?? {};
  const songKey = Object.keys(raw).find((k) => /song|clip|per_output|per_unit/i.test(k));
  if (songKey) {
    const n = Number.parseFloat(raw[songKey]!);
    if (!Number.isNaN(n)) return { amount: n, unit: `USD/${songKey}` };
  }
  if (p.request !== undefined) return { amount: p.request, unit: "USD/request" };
  return null;
}

function summarizeVideoModel(m: RawVideoModel): ModelSummary {
  const sku = m.pricing_skus ?? {};
  const perSec =
    sku["per-video-second"] ??
    sku["per-video-second-1080p"] ??
    sku["per-video-second-720p"] ??
    null;
  const n = perSec !== null ? Number.parseFloat(perSec) : null;
  return {
    id: m.id,
    name: m.name,
    description: m.description ?? "",
    price: n !== null && !Number.isNaN(n) ? { amount: n, unit: "USD/second" } : null,
    pricing: { raw: sku },
    supportedAspectRatios: m.supported_aspect_ratios,
    supportedSizes: m.supported_sizes,
    supportedResolutions: m.supported_resolutions,
  };
}

// ---------- Helpers: image-url + data-url ----------

function toImageUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) return pathOrUrl;
  if (pathOrUrl.startsWith("data:")) return pathOrUrl;
  const bytes = readFileSync(pathOrUrl);
  const mime = guessMime(pathOrUrl);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function guessMime(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".heic":
    case ".heif":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}

function decodeDataUrl(url: string): ImageResult {
  const m = url.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error("generateImage: unexpected image url format");
  return { mimeType: m[1]!, pngBytes: new Uint8Array(Buffer.from(m[2]!, "base64")) };
}

type ImageCompletionResponse = {
  id?: string;
  choices?: Array<{
    message?: { content?: string; images?: Array<{ image_url: { url: string } }> };
  }>;
};

type VideoJob = {
  id: string;
  polling_url: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  unsigned_urls?: string[];
  error?: string;
};

type AudioStreamChunk = {
  id?: string;
  error?: { code?: number; message?: string };
  choices?: Array<{ delta?: { audio?: { data?: string; transcript?: string } } }>;
};
