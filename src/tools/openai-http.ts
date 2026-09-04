/**
 * Tiny OpenAI HTTP wrapper. No SDK — one fetch per endpoint. Today the only
 * live endpoint is Whisper transcription (used for inbound voice notes);
 * image generation and TTS now route through OpenRouter (openrouter-http.ts).
 */
const BASE = "https://api.openai.com/v1";

class OpenAIError extends Error {}

function key(): string {
  const k = process.env.EDMUND_OPENAI_KEY;
  if (!k) throw new OpenAIError("EDMUND_OPENAI_KEY not set");
  return k;
}

export async function transcribeAudio(params: {
  filePath: string;
  model?: string;
}): Promise<string> {
  const file = Bun.file(params.filePath);
  const form = new FormData();
  form.append("file", file, params.filePath.split("/").pop() ?? "audio");
  form.append("model", params.model ?? "whisper-1");
  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}` },
    body: form,
  });
  if (!res.ok) throw new OpenAIError(`audio.transcriptions ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { text?: string };
  return json.text ?? "";
}
