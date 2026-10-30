import type { Config } from "../../../src/config/config.ts";
import { generateAudio } from "../../../src/tools/openrouter-http.ts";
import { mirrorConfig } from "../config.ts";
import { SpeechSidecar } from "./speech.ts";

// Shared with FaceTime calls; they live in core so neither channel imports the other.
export { speakable, speechChunks } from "../../../src/voice/text.ts";

/**
 * Mirror voice I/O. Both directions run locally when [mirror].kokoro_enabled
 * and the sidecar is provisioned, with the hosted OpenRouter path kept as an
 * automatic fallback on either side.
 *
 * STT: local Whisper (base.en) first, then OpenRouter's OpenAI-compatible
 * /audio/transcriptions — voxtral-mini-transcribe, whisper-large-v3 if it errors.
 *
 * TTS: local Kokoro-82M first, then OpenRouter. Every path produces 24 kHz mono
 * PCM16 and shares the WAV wrapper below, so the Pi sees one format no matter
 * which one spoke.
 */

// Same model constellation's remote-mic voice flow uses — proven on this
// exact mic/room. whisper-large-v3 stays as the structural fallback.
const STT_MODEL = "mistralai/voxtral-mini-transcribe";
const STT_FALLBACK_MODEL = "openai/whisper-large-v3";
const MAX_UTTERANCE_BYTES = 8 * 1024 * 1024;
const MAX_TTS_BYTES = 8 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 45_000;

export async function transcribeUtterance(wavBase64: string, config: Config): Promise<string> {
  const estimatedBytes = Math.floor((wavBase64.length * 3) / 4);
  if (estimatedBytes < 44 || estimatedBytes > MAX_UTTERANCE_BYTES) {
    throw new Error("utterance size is outside the accepted bounds");
  }
  // Local Whisper first when provisioned: ~0.25s against ~1s for the hosted
  // round trip, measured at a 0% word error rate on mirror-style phrases. An
  // empty result is not a failure — silence transcribes to nothing — but it is
  // worth a second opinion from the hosted model before giving up on the turn.
  const local = speechSidecar(config);
  if (local) {
    const heard = await local.transcribe(wavBase64);
    if (heard) return heard;
  }

  try {
    return await transcribeViaEndpoint(wavBase64, config, STT_MODEL);
  } catch (err) {
    console.warn(`[mirror] voxtral stt failed (${(err as Error).message}) — whisper fallback`);
    return transcribeViaEndpoint(wavBase64, config, STT_FALLBACK_MODEL);
  }
}

async function transcribeViaEndpoint(
  wavBase64: string,
  config: Config,
  model: string,
): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new File([Buffer.from(wavBase64, "base64")], "utterance.wav", { type: "audio/wav" }),
  );
  form.append("model", model);
  // Vocabulary bias — the wake word is a name ASR models love to mangle.
  form.append("prompt", "Voice commands to Edmund, a smart mirror assistant.");
  const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.keys.openrouter}` },
    body: form,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`transcriptions provider returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

/**
 * One resident sidecar per process, serving both synthesis and recognition. It
 * holds a ~325 MB ONNX graph plus a lazily-loaded Whisper model, so a second
 * instance would double the footprint for no benefit; it is created on first
 * use and only when local speech is actually configured.
 */
let sidecar: SpeechSidecar | null = null;

function speechSidecar(config: Config): SpeechSidecar | null {
  if (!mirrorConfig(config).kokoro_enabled) return null;
  if (!sidecar) {
    const candidate = new SpeechSidecar(config);
    if (!candidate.installed()) {
      // Name what is missing once, at first use, then stop trying. Silently
      // running on the slower hosted path would look like Kokoro "not helping".
      console.warn(
        `[mirror] kokoro_enabled but not provisioned (missing ${candidate.missingPaths().join(", ")}); using hosted speech — run scripts/install-kokoro.sh`,
      );
      mirrorConfig(config).kokoro_enabled = false;
      return null;
    }
    sidecar = candidate;
  }
  return sidecar;
}

/**
 * Start local speech ahead of the utterance. Called on a wake, so the model
 * loads overlap with the person speaking. No-op when local speech is disabled,
 * unprovisioned or already loaded.
 */
export async function warmLocalSpeech(config: Config): Promise<void> {
  await speechSidecar(config)?.warmup();
}

/** Release the sidecar's memory on daemon shutdown. */
export function stopLocalTts(): void {
  sidecar?.stop();
  sidecar = null;
}

export async function synthesizeSpeech(
  text: string,
  config: Config,
): Promise<{ base64: string; format: "wav"; engine?: "local" | "hosted"; engineMs?: number }> {
  const local = speechSidecar(config);
  if (local) {
    const audio = await local.synthesize(text, mirrorConfig(config).kokoro_voice);
    // The Pi enforces its own payload ceiling, so oversized audio would be
    // rejected at the bridge; fall back rather than spend a round trip on it.
    if (audio && audio.pcm.length > 0 && audio.pcm.length <= MAX_TTS_BYTES) {
      return {
        base64: Buffer.from(pcm16ToWav(audio.pcm, audio.sampleRate)).toString("base64"),
        format: "wav",
        engine: "local",
        // The engine's own measurement. Reported alongside the caller's wall
        // clock so a slow synthesis can be attributed: a large gap between the
        // two is transport/queueing, not the model.
        engineMs: audio.synthesisMs,
      };
    }
    if (audio) console.warn("[mirror] kokoro produced an out-of-bounds payload — hosted fallback");
    // A null result was already logged by synthesize(); the hosted path follows.
  }

  // Gemini Flash TTS via OpenRouter's /audio/speech (the OpenAI-compatible
  // TTS endpoint — the chat-completions audio shape is NOT supported for
  // dedicated TTS models). It reads the script it's given; it doesn't chat.
  // Output is raw PCM 24kHz/16-bit mono; wrap in a WAV header for <audio>.
  const model = mirrorConfig(config).tts_model || config.openrouter.default_audio_model;
  const voice = mirrorConfig(config).tts_voice || config.openrouter.default_audio_voice;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.keys.openrouter}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: text, voice, response_format: "pcm" }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`audio/speech provider returned HTTP ${res.status}`);
    }
    const pcm = new Uint8Array(await res.arrayBuffer());
    if (pcm.length === 0 || pcm.length > MAX_TTS_BYTES) {
      throw new Error("audio/speech returned an invalid payload size");
    }
    return {
      base64: Buffer.from(pcm16ToWav(pcm, 24_000)).toString("base64"),
      format: "wav",
      engine: "hosted",
    };
  } catch (err) {
    // Fallback: the chat-audio path with the configured default audio model
    // (verbatim-framed in generateAudio). Keeps the mirror talking if the
    // TTS endpoint or the Gemini preview model has an outage.
    console.warn(
      `[mirror] tts speech endpoint failed (${(err as Error).message}) — chat-audio fallback`,
    );
    const { bytes } = await generateAudio({
      apiKey: config.keys.openrouter,
      model: config.openrouter.default_audio_model,
      voice: config.openrouter.default_audio_voice,
      text,
      format: "pcm16",
    });
    if (bytes.length === 0 || bytes.length > MAX_TTS_BYTES) {
      throw new Error("chat-audio fallback returned an invalid payload size");
    }
    return {
      base64: Buffer.from(pcm16ToWav(bytes, 24_000)).toString("base64"),
      format: "wav",
      engine: "hosted",
    };
  }
}

function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}
