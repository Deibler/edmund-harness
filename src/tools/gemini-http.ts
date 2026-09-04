/**
 * Minimal Gemini client. One endpoint: generateContent with a
 * File-API-uploaded video, for analyze_video (Claude has no native video
 * vision). Image generation routes through OpenRouter — see
 * openrouter-http.ts — not Imagen.
 *
 * Uses the Google Generative Language REST API with an API key query param.
 * No SDK dependency — raw fetches only, same convention as openai-http.ts.
 */
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";

class GeminiError extends Error {}

function key(): string {
  const k = process.env.EDMUND_GEMINI_KEY;
  if (!k) throw new GeminiError("EDMUND_GEMINI_KEY not set");
  return k;
}

/**
 * Upload a video to Gemini's File API and ask a Gemini model to describe /
 * answer questions about it. Claude has no native video vision, so this is
 * how the harness lets the assistant "see" user-sent clips.
 *
 * Flow: resumable-start handshake → single-shot upload/finalize → poll for
 * ACTIVE → generateContent with fileData. The File API is required (not
 * inline base64) because iMessage videos routinely exceed the 20 MB inline
 * cap once they're longer than ~30 seconds.
 */
export async function analyzeVideo(params: {
  filePath: string;
  prompt?: string;
  model?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}): Promise<string> {
  const apiKey = key();
  const bunFile = Bun.file(params.filePath);
  const size = bunFile.size;
  if (!size) throw new GeminiError(`file is empty or missing: ${params.filePath}`);
  const mimeType = mimeForPath(params.filePath);
  const displayName = params.filePath.split("/").pop() ?? "video";
  const model = params.model ?? "gemini-2.5-flash";
  const prompt =
    params.prompt ??
    "Describe this video in detail. Include any spoken words, on-screen text, notable actions, and overall context. If the subject is ambiguous, say so rather than guessing.";

  // 1. Start the resumable upload. The response carries the upload URL in
  //    a custom header; body is empty metadata.
  const startRes = await fetch(`${UPLOAD_BASE}/files?key=${apiKey}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!startRes.ok) {
    throw new GeminiError(`file upload start ${startRes.status}: ${await startRes.text()}`);
  }
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new GeminiError("file upload start returned no upload URL");

  // 2. Send the bytes in a single shot. `upload, finalize` tells the server
  //    this is the whole payload — no chunk tracking on our side.
  const bytes = await bunFile.arrayBuffer();
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!uploadRes.ok) {
    throw new GeminiError(`file upload ${uploadRes.status}: ${await uploadRes.text()}`);
  }
  const uploaded = (await uploadRes.json()) as {
    file?: { name?: string; uri?: string; state?: string };
  };
  const fileName = uploaded.file?.name;
  const fileUri = uploaded.file?.uri;
  if (!fileName || !fileUri) throw new GeminiError("file upload returned no file handle");

  // 3. Poll metadata until processing completes. Gemini transcodes/indexes
  //    the video before it can be referenced; querying before ACTIVE
  //    returns an error.
  const pollIntervalMs = params.pollIntervalMs ?? 2000;
  const maxWaitMs = params.maxWaitMs ?? 180_000;
  const deadline = Date.now() + maxWaitMs;
  let state = uploaded.file?.state ?? "PROCESSING";
  while (state !== "ACTIVE") {
    if (state === "FAILED") throw new GeminiError(`file processing failed: ${fileName}`);
    if (Date.now() > deadline) {
      throw new GeminiError(`file processing timed out after ${maxWaitMs}ms (state=${state})`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollRes = await fetch(`${BASE}/${fileName}?key=${apiKey}`);
    if (!pollRes.ok) {
      throw new GeminiError(`file poll ${pollRes.status}: ${await pollRes.text()}`);
    }
    const pollJson = (await pollRes.json()) as { state?: string };
    state = pollJson.state ?? "UNKNOWN";
  }

  // 4. Ask the model to analyze it. fileData references the upload by URI;
  //    no re-upload on subsequent calls (files live ~48h on Google's side).
  const genRes = await fetch(`${BASE}/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ file_data: { mime_type: mimeType, file_uri: fileUri } }, { text: prompt }],
        },
      ],
    }),
  });
  if (!genRes.ok) {
    throw new GeminiError(`generateContent ${genRes.status}: ${await genRes.text()}`);
  }
  const genJson = (await genRes.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text =
    genJson.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim() ?? "";
  if (!text) throw new GeminiError("generateContent returned no text");
  return text;
}

function mimeForPath(p: string): string {
  const ext = p.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    mpeg: "video/mpeg",
    mpg: "video/mpeg",
    webm: "video/webm",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
  };
  return map[ext] ?? "application/octet-stream";
}
