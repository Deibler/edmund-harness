import type { HistoryLine } from "../imessage/history.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { historyStamp } from "../util/clock.ts";

/**
 * Render recent messages for the envelope header.
 *
 * The format is **speaker-tagged** so the model can attribute every line
 * without arithmetic on timestamps or guessing from a single `From:`
 * field at the top:
 *
 *   [Jordan · Sat 14:58] hey edmund
 *   [Riley  · Sat 14:59] lol
 *   [You    · Sat 15:00] hi everyone
 *
 * If `topicBreaks` is non-empty, an inline separator is injected just
 * before each indicated index, e.g. `  --- 18m gap ---`. The break
 * indices refer to positions in the input `lines`, not the output array.
 */
export function formatHistoryLines(
  lines: HistoryLine[],
  contacts: ContactBook,
  topicBreaks: number[] = [],
): string[] {
  const breakSet = new Set(topicBreaks);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (breakSet.has(i) && i > 0) {
      const gapMs = lines[i]!.timestampMs - lines[i - 1]!.timestampMs;
      out.push(`  --- ${formatGap(gapMs)} gap ---`);
    }
    const l = lines[i]!;
    const who = l.fromMe ? "You" : (contacts.label(l.fromHandle) ?? l.fromHandle ?? "unknown");
    // Name whose message a reaction was aimed at. A tapback arrives as a row
    // reading `Questioned "…"` that quotes its target, and the quote alone is
    // ambiguous about WHO is being reacted to. In a group that misfired: a
    // reaction to someone else's message happened to quote a line beginning
    // "Edmund, …", was read as aimed at Edmund, and got answered sharply at
    // the wrong person. Saying the target out loud removes the guess.
    const aimed = l.isTapback
      ? l.tapbackTargetIsMe
        ? " (reacting to YOUR message)"
        : l.tapbackTargetHandle
          ? ` (reacting to ${contacts.label(l.tapbackTargetHandle) ?? l.tapbackTargetHandle}'s message, not yours)`
          : ""
      : "";
    out.push(`  [${who} · ${historyStamp(l.timestampMs)}] ${l.text}${aimed}`);
  }
  return out;
}

/** Map handles to display names via ContactBook, dedupe, preserve input order. */
export function formatParticipantList(handles: string[], contacts: ContactBook): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of handles) {
    const name = contacts.label(h) ?? h;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function formatGap(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
