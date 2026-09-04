import { OUTPUT_RULES } from "../claude/system-prompt.ts";
import type { Config } from "../config/config.ts";
import { ChatDb } from "../imessage/db.ts";
import { getRecentMessages } from "../imessage/history.ts";
import { runModelOneShot } from "../model/one-shot.ts";
import { recordSpend } from "../spend/ledger.ts";

/**
 * The judge half of the eval loop: sample real outbound transcripts,
 * score EDMUND's messages against the live output contract on three
 * axes, return structured scores. One cheap model call per sample.
 *
 * Axes (1-10 each; 10 = flawless):
 *   format  — obeys the iMessage hard limits (no markdown, no bullet
 *             spam, no section labels, no em-dashes)
 *   length  — texting-sized replies; long only when depth was asked for
 *   persona — sounds like Edmund texting a friend, not an assistant
 */

export type JudgeScore = { format: number; length: number; persona: number; note: string };

export type TranscriptSample = {
  /** chat guid (weekly) or probe id (probes). */
  subject: string;
  /** Speaker-tagged transcript text, oldest first. */
  text: string;
};

const JUDGE_TIMEOUT_MS = 90_000;

const JUDGE_SYSTEM = `You are a strict QA judge for an AI persona named Edmund that texts people over iMessage.
You will be given a transcript (or a single reply). Score ONLY the messages marked EDMUND against
the output contract below. The other speakers are humans — never score them.

THE OUTPUT CONTRACT EDMUND MUST FOLLOW:
${OUTPUT_RULES}

Score three axes, each an integer 1-10 (10 = flawless, 5 = clearly flawed, 1 = egregious):
- "format": hard-limit compliance — markdown characters, bullet lists without being asked,
  section labels, em-dashes, multi-bubble structure abuse.
- "length": replies sized like texts; long answers only where the human asked for depth.
- "persona": voice — texting a friend vs assistant-speak ("Let me know if...", "I'd be happy to..."),
  hedging boilerplate, narrating tools, breaking character.

Judge the WORST offense present, not the average — one memo-formatted bullet-bomb in an otherwise
clean transcript caps "format" at 4. If Edmund sent no messages in the transcript, score all axes 5
and note "no bot messages".

Output ONE JSON object, nothing else:
{"format": n, "length": n, "persona": n, "note": "<≤120 chars: the main offense, or 'clean'>"}`;

/**
 * Merge consecutive same-speaker messages sent within `windowMs` into one
 * logical message. The harness chunks long replies into multiple bubbles
 * 400ms apart — judged separately they read as "cut off mid-sentence"
 * (observed on the first weekly run), which dings format/length for what
 * is actually ONE well-formed reply.
 */
export function mergeBubbles<
  T extends { fromMe: boolean; fromHandle: string; timestampMs: number; text: string },
>(lines: T[], windowMs = 90_000): Array<{ fromMe: boolean; fromHandle: string; text: string }> {
  const out: Array<{ fromMe: boolean; fromHandle: string; text: string; lastMs: number }> = [];
  for (const l of lines) {
    const prev = out.at(-1);
    if (
      prev &&
      prev.fromMe === l.fromMe &&
      prev.fromHandle === l.fromHandle &&
      l.timestampMs - prev.lastMs <= windowMs
    ) {
      prev.text += `\n${l.text}`;
      prev.lastMs = l.timestampMs;
    } else {
      out.push({ fromMe: l.fromMe, fromHandle: l.fromHandle, text: l.text, lastMs: l.timestampMs });
    }
  }
  return out.map(({ lastMs: _lastMs, ...rest }) => rest);
}

/**
 * Sample transcript slices from the most active chats of the window.
 * chat.db only holds real iMessage traffic, so mirror/trading venues are
 * excluded by construction.
 */
export function sampleTranscripts(
  chatDb: ChatDb,
  opts: { days: number; maxChats: number; lines: number },
  nowMs = Date.now(),
): TranscriptSample[] {
  const sinceNs = (nowMs - opts.days * 86_400_000 - ChatDb.APPLE_EPOCH_MS) * ChatDb.NS_PER_MS;
  const chats = chatDb
    .query<{ guid: string; n: number }>(
      `SELECT c.guid AS guid, COUNT(*) AS n
       FROM message m
       JOIN chat_message_join j ON j.message_id = m.ROWID
       JOIN chat c ON c.ROWID = j.chat_id
       WHERE m.date >= ? AND m.is_from_me = 1
         AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
       GROUP BY c.guid
       ORDER BY n DESC
       LIMIT ?`,
    )
    .all(sinceNs, opts.maxChats) as Array<{ guid: string; n: number }>;

  const samples: TranscriptSample[] = [];
  for (const c of chats) {
    const lines = getRecentMessages(chatDb, c.guid, Number.MAX_SAFE_INTEGER, opts.lines);
    if (lines.length === 0 || !lines.some((l) => l.fromMe)) continue;
    const text = mergeBubbles(lines)
      .map((l) => {
        const who = l.fromMe ? "EDMUND" : l.fromHandle || "them";
        return `${who}: ${l.text.replace(/\n/g, " ⏎ ").slice(0, 1200)}`;
      })
      .join("\n");
    samples.push({ subject: c.guid, text });
  }
  return samples;
}

/** Judge one sample. Returns null on any failure — a broken judge call
 *  drops the sample, never the run. */
export async function judgeSample(
  sample: TranscriptSample,
  config: Config,
  spend?: { dataDir: string; sessionKey: string },
): Promise<JudgeScore | null> {
  try {
    const r = await runModelOneShot({
      args: [
        "--model",
        config.evals.judge_model,
        "--permission-mode",
        "bypassPermissions",
        "--append-system-prompt",
        JUDGE_SYSTEM,
      ],
      input: `TRANSCRIPT:\n${sample.text.slice(0, 12_000)}`,
      timeoutMs: JUDGE_TIMEOUT_MS,
    });
    if (spend) {
      recordSpend(spend.dataDir, {
        sessionKey: spend.sessionKey,
        subsystem: "eval-judge",
        model: config.evals.judge_model,
        costUsd: r.costUsd,
        durMs: r.durationMs,
      });
    }
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as Partial<JudgeScore>;
    const clamp = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(10, Math.round(v))) : null;
    const format = clamp(parsed.format);
    const length = clamp(parsed.length);
    const persona = clamp(parsed.persona);
    if (format === null || length === null || persona === null) return null;
    return { format, length, persona, note: String(parsed.note ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}
