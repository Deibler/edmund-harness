import { formatHistoryLines } from "../channels/history-format.ts";
import type { ChatDb } from "../imessage/db.ts";
import type { HistoryLine } from "../imessage/history.ts";
import { getRecentMessages, resolveBeforeRowId } from "../imessage/history.ts";
import { listAttachments } from "../imessage/search.ts";
import { runModelOneShot } from "../model/one-shot.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { recordSpend } from "../spend/ledger.ts";
import { log } from "../util/log.ts";

/**
 * Catch-me-up sub-worker.
 *
 * Spawns a fast Haiku `claude -p` synchronously to produce a structured
 * summary of everything in the chat since the model last spoke (or since
 * a caller-supplied anchor). The parent turn blocks on the result, then
 * uses it to inform its own reply.
 *
 * Design choices:
 *   - **Haiku, not Sonnet.** A recap is a summarization task: small context
 *     window, no tool orchestration needed, latency-sensitive (the parent
 *     turn is blocked). Haiku-4.5 finishes in 3–8s for a typical recap.
 *   - **Text input + image paths.** We embed media as `[image at /path]` /
 *     `[voice memo at /path]` lines in the transcript. The sub-worker has
 *     the built-in `Read` tool and can pull any image it wants to look at —
 *     keeps the prompt small while still letting Haiku verify visuals when
 *     it matters.
 *   - **Awaited + capped.** The parent turn awaits the result (its session
 *     lock is held meanwhile), so we hard-cap at `MAX_WAIT_MS` (45s) and let
 *     the parent get back a "(recap timed out)" sentinel rather than hanging
 *     forever. (This used to be spawnSync, which froze the host process's
 *     whole event loop for the duration.)
 *   - **No MCP config.** The sub-worker doesn't need the daemon's tool
 *     surface (sending messages, scheduling crons, etc.). Strip it to
 *     keep the worker fast and isolated.
 */

const MAX_MESSAGES = 200;
const MAX_IMAGE_PATHS = 12;
const MAX_WAIT_MS = 45_000;
const DEFAULT_MODEL = "claude-haiku-4-5";

export type CatchUpArgs = {
  chatDb: ChatDb;
  contacts: ContactBook;
  chatGuids: string[];
  /** Lower-bound timestamp; messages strictly after this are summarized. */
  sinceMs: number;
  /** Upper-bound timestamp (defaults to now). Useful in tests / replay. */
  untilMs?: number;
  /** Caller-side hard cap (subject to MAX_MESSAGES). */
  maxMessages?: number;
  /** Optional per-line visibility gate (orchestrator privacy filtering).
   *  Lines failing it are excluded before the summarizer sees anything. */
  lineFilter?: (line: HistoryLine) => boolean;
  /** When set, the sub-worker's cost lands in the spend ledger
   *  (subsystem "catch-up") attributed to this session. */
  spend?: { dataDir: string; sessionKey: string };
};

export type CatchUpResult =
  | { ok: true; summary: string; messageCount: number; imageCount: number; elapsedMs: number }
  | { ok: false; error: string };

export async function runCatchUp(args: CatchUpArgs): Promise<CatchUpResult> {
  const start = Date.now();
  const untilMs = args.untilMs ?? Date.now();
  const cap = Math.min(args.maxMessages ?? MAX_MESSAGES, MAX_MESSAGES);

  // Pull messages strictly after `sinceMs` and ≤ `untilMs` from every guid
  // in scope. resolveBeforeRowId gives us the right anchor for the upper
  // bound; we filter by `timestampMs > sinceMs` after the fetch.
  const fetched: HistoryLine[] = args.chatGuids.flatMap((g) => {
    const anchor = resolveBeforeRowId(args.chatDb, g, untilMs + 1);
    if (anchor <= 0) return [];
    // Pull generously; we'll trim below. Most chats won't have 500 msgs in
    // the catch-up window, but cap defensively.
    return getRecentMessages(args.chatDb, g, anchor, 500);
  });

  const window = fetched
    .filter((l) => l.timestampMs > args.sinceMs)
    .filter(args.lineFilter ?? (() => true))
    .sort((a, b) => a.timestampMs - b.timestampMs);
  if (window.length === 0) {
    return {
      ok: true,
      summary: "nothing happened in this chat since you last spoke.",
      messageCount: 0,
      imageCount: 0,
      elapsedMs: Date.now() - start,
    };
  }
  const trimmed = window.length > cap ? window.slice(-cap) : window;

  // Pull image attachments in the same window (mime image/*). Capped — too
  // many slows the sub-worker down without adding much.
  const imageHits = args.chatGuids.flatMap((g) =>
    listAttachments(args.chatDb, {
      chatGuids: [g],
      mimePrefix: "image/",
      sinceMs: args.sinceMs,
      untilMs,
      limit: MAX_IMAGE_PATHS,
    }),
  );
  const images = imageHits.slice(0, MAX_IMAGE_PATHS);

  // Format history for the sub-worker. Same speaker-tagged format the
  // envelope uses — visually consistent with what the parent model sees.
  const tagged = formatHistoryLines(trimmed, args.contacts, []).join("\n");
  const imagePathBlock =
    images.length > 0
      ? `\nAttachments in this window (call \`Read\` on any you want to inspect):\n${images.map((h) => `  ${new Date(h.timestampMs).toISOString()} ${h.mimeType} ${h.filePath}`).join("\n")}\n`
      : "";

  const prompt = buildPrompt(tagged, imagePathBlock, args.sinceMs, untilMs, trimmed.length);

  const res = await runModelOneShot({
    args: ["--model", DEFAULT_MODEL, "--permission-mode", "bypassPermissions"],
    input: prompt,
    timeoutMs: MAX_WAIT_MS,
  });
  if (args.spend) {
    recordSpend(args.spend.dataDir, {
      sessionKey: args.spend.sessionKey,
      subsystem: "catch-up",
      model: res.model ?? DEFAULT_MODEL,
      costUsd: res.costUsd,
      durMs: res.durationMs,
    });
  }

  if (!res.ok) {
    log.warn("catch-up", "sub-worker failed", {
      err: res.error ?? "unknown",
      stderr: res.stderr.slice(0, 400),
    });
    return { ok: false, error: res.error ?? "catch-up sub-worker failed" };
  }
  const summary = res.text;
  const elapsed = Date.now() - start;
  log.info("catch-up", "done", {
    messages: trimmed.length,
    images: images.length,
    elapsed_ms: elapsed,
    chars: summary.length,
  });
  return {
    ok: true,
    summary,
    messageCount: trimmed.length,
    imageCount: images.length,
    elapsedMs: elapsed,
  };
}

function buildPrompt(
  tagged: string,
  imagePathBlock: string,
  sinceMs: number,
  untilMs: number,
  msgCount: number,
): string {
  const since = new Date(sinceMs).toISOString();
  const until = new Date(untilMs).toISOString();
  return [
    "You are catching another assistant up on a group iMessage chat they missed.",
    `Window: ${since} → ${until} (${msgCount} messages).`,
    "",
    "Produce a structured, concise recap. No preamble, no sign-off. Use this exact shape:",
    "",
    "Participants active: <Name (msg count), ...>",
    "Topics:",
    "  1. <topic name> — <one sentence: who said what, where it landed>",
    "  2. ...",
    "Unresolved: <questions or commitments nobody answered; 'none' if everything resolved>",
    "Media highlights: <one line per noteworthy image, with sender + ISO time>",
    "Tone: <one line: e.g. 'casual planning', 'tense after a newcomer joined', 'mostly one person venting'>",
    "",
    "Guidance:",
    "  - Be brief. The reader is an assistant about to reply; they need orientation, not a transcript.",
    "  - Attribute claims by name. Don't say 'someone' — the transcript names everyone.",
    "  - If an image looks load-bearing (a screenshot being debated, a photo someone asked for opinions on), call `Read` on its path before describing it. Skip images that are clearly incidental.",
    "  - Don't speculate about intent you can't see in the messages.",
    "",
    imagePathBlock,
    "Transcript:",
    tagged,
  ].join("\n");
}
