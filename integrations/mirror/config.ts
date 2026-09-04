/**
 * `[mirror]` configuration for the mirror integration.
 *
 * The schema lives HERE, with the package, rather than in core's
 * `src/config/config.ts`. Core keeps the raw `[mirror]` table from config.toml
 * as an opaque value and never validates or types it — that is what lets this
 * integration be deleted without touching the core schema.
 *
 * Call `mirrorConfig(config)` to get a validated, typed view. Results are memoized
 * per Config object, so repeated calls on a hot path cost one WeakMap lookup.
 */

import { z } from "zod";
import { defineSection } from "../../src/integrations/section.ts";

export const Schema = z
  .object({
    /** Master switch. False = no bridge, no tools, no session. */
    enabled: z.boolean().default(false),
    /**
     * Mirror-only Claude profile. Voice interaction is latency-sensitive,
     * so it deliberately does not inherit the heavier iMessage default.
     */
    model: z.string().default("claude-sonnet-5[1m]"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
    /** Pi host (IP or hostname). */
    host: z.string().trim().max(253).default(""),
    /** Mirror bridge port on the Pi (CONSTELLATION_MIRROR_PORT). */
    port: z.number().int().min(1).max(65_535).default(8789),
    /** Constellation household token (CONSTELLATION_TOKEN on the Pi). */
    token: z.string().max(512).default(""),
    /** TTS model (OpenRouter id). A dedicated TTS model — it reads the text
     *  it is given; never a chat-audio model, which can ad-lib. */
    tts_model: z.string().default("google/gemini-3.1-flash-tts-preview"),
    /** TTS voice name for the model above. */
    tts_voice: z.string().default("Zubenelgenubi"),
    /**
     * Local Kokoro-82M synthesis, tried before the OpenRouter models above
     * and falling back to them on any failure. Measured on this Mac it is
     * ~2.5-4x faster than the hosted path and free of its ±2s jitter, which
     * matters more in conversation than the raw average. Provision with
     * scripts/install-kokoro.sh; if anything it needs is missing the daemon
     * logs once at boot and keeps using OpenRouter.
     */
    kokoro_enabled: z.boolean().default(false),
    /** Kokoro voice id (see VOICES.md upstream; af_heart/af_bella grade highest). */
    kokoro_voice: z.string().default("af_heart"),
    /** venv interpreter with kokoro-onnx installed. Blank = the standard path. */
    kokoro_python: z.string().default(""),
    /** ONNX graph. Blank = the standard path. fp32 is intentional: int8
     *  measured 2x slower on this ARM CPU. */
    kokoro_model: z.string().default(""),
    /** Packed voice styles (voices-v1.0.bin). Blank = the standard path. */
    kokoro_voices: z.string().default(""),
    /**
     * Local faster-whisper model for recognition, loaded lazily inside the
     * same sidecar. base.en measured 0.25s at a 0% word error rate on
     * mirror-style phrases here; tiny.en is ~2x faster and small.en ~3x
     * slower for no accuracy gain on this vocabulary. Blank disables local
     * recognition while leaving local synthesis on.
     */
    local_stt_model: z.string().default("base.en"),
    /** After the mirror speaks, open a no-wake-word follow-up window. */
    followup_window: z.boolean().default(true),
    /** Default lifetime for non-persistent visual replies and content. */
    default_ttl_seconds: z.number().int().min(15).max(86_400).default(300),
    /** Session key for the mirror's own voice conversations. */
    session_key: z
      .string()
      .regex(/^mirror:[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/)
      .default("mirror:pi-4"),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(value.host)) {
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "enabled mirror requires a hostname or IPv4 address without a URL/path",
      });
    }
    if (value.token.length < 16) {
      ctx.addIssue({
        code: "custom",
        path: ["token"],
        message: "enabled mirror requires the Constellation household token",
      });
    }
  })
  .default({});

export type MirrorConfig = z.infer<typeof Schema>;

/**
 * Validated `[mirror]` settings, memoized per Config object. A missing or
 * malformed table degrades to schema defaults (and logs) instead of
 * preventing the daemon from booting.
 */
export const mirrorConfig = defineSection("mirror", Schema);
