import type { Config } from "../../../src/config/config.ts";
import { generateAudio } from "../../../src/tools/openrouter-http.ts";
import { mirrorConfig } from "../config.ts";
import { SpeechSidecar } from "./speech.ts";

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
/** Below this, a sentence is not worth its own request and audible seam. */
const MIN_CHUNK_CHARS = 24;
/** Trailing tokens whose period ends an abbreviation, not a sentence. */
const ABBREVIATION_END =
  /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|ave|rd|vs|etc|approx|no|fig|inc|ltd|co|dept|est|min|max|[a-z])\.$/i;
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
 * Boot local speech before anyone speaks. Called once at daemon start so the
 * model loads land on idle time instead of the first utterance. No-op when
 * local speech is disabled or unprovisioned.
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

/**
 * Split a reply into utterances that can be synthesized and sent independently.
 *
 * Time-to-first-audio is what a conversation actually feels like, and it is
 * bounded by the FIRST chunk rather than the whole reply — a long answer starts
 * speaking in a few hundred milliseconds instead of a few seconds. The Pi
 * already queues and plays chunks back-to-back, so this needs no protocol
 * change.
 *
 * Splits on sentence ends only. Prosody carries across a comma but not a full
 * stop, so anything finer would be audible as chopped-up speech, and short
 * trailing fragments are merged back for the same reason.
 */
export function speechChunks(text: string, maxChunks = 8): string[] {
  const clean = text.trim();
  if (!clean) return [];
  // Split only at a terminator followed by whitespace and the start of the next
  // sentence — never inside a token. Matching bare [.!?] would cut "82.4" into
  // "82." and "4", which is audible as "eighty two. four degrees." Punctuation
  // stays attached; the synthesizer needs it for falling intonation.
  const sentences = clean.split(/(?<=[.!?]["')\]]*)\s+(?=["'([]*[A-Z0-9])/);
  if (sentences.length === 0) return [clean];

  const chunks: string[] = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const previous = chunks.at(-1);
    // "Dr." / "No." / an initial is a terminator by shape only — rejoin so the
    // sentence is spoken as one breath.
    if (previous !== undefined && ABBREVIATION_END.test(previous)) {
      chunks[chunks.length - 1] = `${previous} ${sentence}`;
      continue;
    }
    // A lone "Sure." or "1998." is too short to be worth its own request and
    // its own audible gap; fold it into its neighbour.
    if (
      previous !== undefined &&
      (sentence.length < MIN_CHUNK_CHARS || previous.length < MIN_CHUNK_CHARS)
    ) {
      chunks[chunks.length - 1] = `${previous} ${sentence}`;
      continue;
    }
    chunks.push(sentence);
  }
  if (chunks.length === 0) return [clean];
  // The screen's audio queue is bounded; past that, pack the remainder into the
  // last chunk rather than dropping any of the reply.
  if (chunks.length > maxChunks) {
    const head = chunks.slice(0, maxChunks - 1);
    head.push(chunks.slice(maxChunks - 1).join(" "));
    return head;
  }
  return chunks;
}

/**
 * Strip markdown and other chat-formatting the TTS would read literally.
 * The mirror reply is SPOKEN — asterisks, backticks, and link syntax all
 * turn into noise on the speaker.
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
