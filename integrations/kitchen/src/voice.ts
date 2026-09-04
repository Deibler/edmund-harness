/**
 * Talking to me from the stove.
 *
 * The chat button was the wrong shape for the moment it exists to serve. Half
 * way through a recipe your hands are wet, the phone is propped against the
 * kettle, and the question is "can I use milk instead" or "how do I know when
 * this is done". Typing that means drying your hands, leaving the step you were
 * on, and reading an answer, which is three interruptions to avoid one.
 *
 * So: speak the question, hear the answer, never leave the step. Same shape as
 * the mirror, which is the other place I get asked things by somebody whose
 * hands are busy.
 *
 * HOW IT MOVES. The page has no server of its own, so the question goes out on
 * the same callback endpoint every other button uses, and the answer comes back
 * as two files written next to the page: an m4a and a line in a per-person JSON
 * the page polls. That is deliberately the same mechanism as the text chat
 * rather than a new one, because it is already proven behind the share token.
 *
 * SPEECH IN is the browser's own recogniser, which costs nothing, needs no
 * upload, and works offline. SPEECH OUT is generated here so it is my voice
 * rather than the system's, with the browser's synthesiser as the fallback when
 * generation fails. Answering in a robot voice beats not answering.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRecipe } from "./cookbook.ts";
import { openrouterKey } from "./openrouter.ts";
import { live } from "./store.ts";

/** Kept short on purpose: this is read aloud, and nobody wants a paragraph. */
const MAX_WORDS = 70;

export type VoiceAsk = {
  /** The browser's id for this question, so it can poll for its own answer. */
  rid: string;
  text: string;
  /** Recipe page they were on, and which step, when they asked. */
  recipe?: string | null;
  step?: number | null;
};

export type VoiceTurn = {
  rid: string;
  ask: string;
  say: string;
  /** Path relative to the page, or null when synthesis failed. */
  audio: string | null;
  ts: string;
};

/**
 * The answer, in the voice of somebody standing in this kitchen.
 *
 * Given the actual step they are on and the actual shelves, because the whole
 * point is that it beats a search engine: "can I use milk instead" has a real
 * answer here and a generic one anywhere else.
 */
async function answer(account: string, ask: VoiceAsk): Promise<string> {
  const stock = live(account)
    .map((i) => i.name)
    .sort()
    .join(", ");
  const r = ask.recipe ? getRecipe(account, ask.recipe) : null;
  const step = r && ask.step ? r.steps.find((s) => s.n === ask.step) : null;

  const prompt = [
    "You are Edmund, answering out loud to somebody who is cooking right now and",
    "cannot read. Answer the question and nothing else.",
    "",
    r ? `They are cooking: ${r.name}. ${r.desc}` : "They are somewhere in the kitchen site.",
    step ? `They are on step ${step.n} of ${r!.steps.length}: "${step.title}". ${step.body}` : "",
    r
      ? `The full ingredient list: ${r.ingredients.map((i) => `${i.amount} ${i.name}`).join(", ")}`
      : "",
    "",
    `In the kitchen right now: ${stock}`,
    "",
    `They asked: "${ask.text}"`,
    "",
    `Rules. Under ${MAX_WORDS} words. Spoken English, so no lists, no headings, no`,
    "markdown, no emoji, no em-dashes. Lead with the answer. If the answer depends on",
    "something in this kitchen, say the real thing rather than a general rule. If you do",
    "not know, say so in one short sentence rather than guessing.",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openrouterKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return (d.choices[0]?.message?.content ?? "").trim();
}

/**
 * Speak it, and write the file the page will play.
 *
 * The model only emits audio when streaming, and only as raw pcm16 when it
 * does, which no browser will play. So the stream is collected and handed to
 * ffmpeg, which is the same pipeline the voice memos use. Returns null rather
 * than throwing: a missing audio file makes the page fall back to its own
 * synthesiser, and a spoken answer in the wrong voice is far better than a
 * question that goes unanswered because a codec was unavailable.
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

/** Where a person's spoken thread lives, next to the page they are reading. */
export const safeName = (p: string) => p.replace(/[^A-Za-z0-9+.-]/g, "_");

export function threadPath(artifactDir: string, principal: string): string {
  return join(artifactDir, "voice", `${safeName(principal)}.json`);
}

export function readVoice(artifactDir: string, principal: string): VoiceTurn[] {
  const p = threadPath(artifactDir, principal);
  if (!existsSync(p)) return [];
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { turns?: VoiceTurn[] }).turns ?? [];
  } catch {
    return [];
  }
}

/**
 * Answer one spoken question end to end.
 *
 * The turn is appended whether or not the audio worked, so the page always has
 * something to show and read out. Only the last twenty are kept: this is a
 * conversation at a stove, not a record.
 */
export async function handleVoice(
  account: string,
  artifactDir: string,
  principal: string,
  ask: VoiceAsk,
): Promise<VoiceTurn> {
  const say = await answer(account, ask);
  const dir = join(artifactDir, "voice");
  mkdirSync(dir, { recursive: true });

  const file = `${safeName(principal)}-${ask.rid}.m4a`;
  let ok = false;
  try {
    ok = await speak(say, join(dir, file));
  } catch {
    /* falls back to the browser's own voice */
  }

  const turn: VoiceTurn = {
    rid: ask.rid,
    ask: ask.text,
    say,
    audio: ok ? `voice/${file}` : null,
    ts: new Date().toISOString(),
  };
  const turns = [...readVoice(artifactDir, principal), turn].slice(-20);
  writeFileSync(threadPath(artifactDir, principal), JSON.stringify({ turns }, null, 2));
  return turn;
}
