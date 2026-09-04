/**
 * A refused music/TTS generation answers HTTP 200 and puts the refusal inside
 * the SSE body. The stream reader used to drop any line it couldn't find audio
 * in, so a blocked prompt produced a 0-byte mp3 and a cheerful "Audio
 * generated" summary. These lock the two ways that can happen.
 */
import { describe, expect, it, afterEach } from "bun:test";
import { generateAudio } from "../src/tools/openrouter-http";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve a canned SSE body from the OpenRouter chat endpoint. */
function stubStream(lines: string[]): void {
  globalThis.fetch = (async () =>
    new Response(new TextEncoder().encode(lines.map((l) => `${l}\n`).join("")), {
      status: 200,
    })) as typeof fetch;
}

const args = { apiKey: "k", model: "google/lyria-3-clip-preview", text: "hi", voice: "alloy" };

function audioLine(b64: string, transcript?: string): string {
  const delta: Record<string, unknown> = { audio: { data: b64, transcript } };
  return `data: ${JSON.stringify({ choices: [{ delta }] })}`;
}

describe("generateAudio", () => {
  it("throws the provider's refusal instead of returning empty bytes", async () => {
    stubStream([
      ": OPENROUTER PROCESSING",
      `data: ${JSON.stringify({
        choices: [],
        error: { code: 400, message: "Gemini blocked the request: PROHIBITED_CONTENT" },
      })}`,
      "data: [DONE]",
    ]);
    await expect(generateAudio(args)).rejects.toThrow("PROHIBITED_CONTENT");
  });

  it("throws when the stream carries no audio at all", async () => {
    stubStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<instrumental>" } }] })}`,
      "data: [DONE]",
    ]);
    await expect(generateAudio(args)).rejects.toThrow("no audio");
  });

  it("still returns audio and transcript on a good stream", async () => {
    const b64 = Buffer.from("ID3fake-audio").toString("base64");
    stubStream([
      audioLine(b64.slice(0, 8), "one "),
      audioLine(b64.slice(8), "two"),
      "data: [DONE]",
    ]);
    const out = await generateAudio(args);
    expect(Buffer.from(out.bytes).toString()).toBe("ID3fake-audio");
    expect(out.transcript).toBe("one two");
    expect(out.format).toBe("mp3");
  });

  it("does not swallow a malformed line", async () => {
    const b64 = Buffer.from("ok").toString("base64");
    stubStream(["data: {not json", audioLine(b64), "data: [DONE]"]);
    const out = await generateAudio(args);
    expect(Buffer.from(out.bytes).toString()).toBe("ok");
  });
});
