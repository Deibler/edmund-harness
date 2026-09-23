/**
 * Spoken answers for questions asked aloud from a recipe page.
 *
 * Speech in is the browser's own recogniser. The answer is written by the
 * household's main session (woken by `wake.ts`) and delivered through
 * `kitchen_voice`; this module only speaks it and files it where the page
 * polls: an m4a plus a line in a per-person JSON, the same file-and-poll path
 * the text chat uses. When synthesis fails the page falls back to the browser's
 * speech synthesiser.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openrouterKey } from "./openrouter.ts";

/** Answers are read aloud, so they stay short. */
export const MAX_WORDS = 70;

export type VoiceTurn = {
  rid: string;
  ask: string;
  say: string;
  /** Path relative to the page, or null when synthesis failed. */
  audio: string | null;
  ts: string;
};

/**
 * Synthesise `text` into an m4a at `dest`. The model streams raw pcm16, which
 * browsers cannot play, so the stream is collected and transcoded with ffmpeg.
 * Returns false rather than throwing; the page then uses its own synthesiser.
 */
async function speak(text: string, dest: string): Promise<boolean> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openrouterKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-audio",
      modalities: ["text", "audio"],
      audio: { voice: "onyx", format: "pcm16" },
      stream: true,
      messages: [{ role: "user", content: `Read this aloud exactly, warm and unhurried: ${text}` }],
    }),
  });
  if (!res.ok || !res.body) return false;

  const parts: Buffer[] = [];
  let buf = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // Server-sent events arrive split across reads, so only whole lines are
    // parsed and the trailing partial is carried into the next chunk.
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const p = line.slice(6).trim();
      if (p === "[DONE]") continue;
      try {
        const d = JSON.parse(p) as { choices?: Array<{ delta?: { audio?: { data?: string } } }> };
        const b64 = d.choices?.[0]?.delta?.audio?.data;
        if (b64) parts.push(Buffer.from(b64, "base64"));
      } catch {
        /* a torn frame costs that frame, not the answer */
      }
    }
  }
  const pcm = Buffer.concat(parts);
  if (pcm.length < 4000) return false;

  const tmp = `${dest}.pcm16`;
  writeFileSync(tmp, pcm);
  const r = spawnSync("/opt/homebrew/bin/ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-i",
    tmp,
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    dest,
  ]);
  rmSync(tmp, { force: true });
  return r.status === 0 && existsSync(dest);
}

const safeName = (p: string) => p.replace(/[^A-Za-z0-9+.-]/g, "_");

/** Where a person's spoken thread lives, next to the page they are reading. */
function threadPath(artifactDir: string, principal: string): string {
  return join(artifactDir, "voice", `${safeName(principal)}.json`);
}

function readVoice(artifactDir: string, principal: string): VoiceTurn[] {
  const p = threadPath(artifactDir, principal);
  if (!existsSync(p)) return [];
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { turns?: VoiceTurn[] }).turns ?? [];
  } catch {
    return [];
  }
}

/**
 * Speak one answer and file it for the page. The turn is recorded even when
 * the audio fails, so the page always has text to show; the last twenty are kept.
 */
export async function sayVoice(
  artifactDir: string,
  principal: string,
  turn: { rid: string; ask: string; say: string },
): Promise<VoiceTurn> {
  const dir = join(artifactDir, "voice");
  mkdirSync(dir, { recursive: true });

  const file = `${safeName(principal)}-${turn.rid}.m4a`;
  let ok = false;
  try {
    ok = await speak(turn.say, join(dir, file));
  } catch {
    /* falls back to the browser's own voice */
  }

  const t: VoiceTurn = {
    rid: turn.rid,
    ask: turn.ask,
    say: turn.say,
    audio: ok ? `voice/${file}` : null,
    ts: new Date().toISOString(),
  };
  const turns = [...readVoice(artifactDir, principal).filter((x) => x.rid !== t.rid), t].slice(-20);
  writeFileSync(threadPath(artifactDir, principal), JSON.stringify({ turns }, null, 2));
  return t;
}
