import type { ChatDb } from "../imessage/db.ts";
import { decodeMessageText } from "../imessage/decode.ts";
import { envelopeStamp } from "../util/clock.ts";

/**
 * How a recurring job's last sends landed, read from chat.db: what each fire
 * sent and whether anyone answered before the next one. A scheduled job used
 * to compose every fire blind. Measured over the 30 days to 2026-10-25: one
 * job feed got 25 sends and 0 replies and kept going a week after the person
 * changed fields; the same posting went out 8 days running; a dinner text was
 * cooked as sent once in 39. The model now sees the record and decides; the
 * harness never skips a fire on its own (a scheduled send is not a reply, but
 * the choice to stop still belongs to the model and the person).
 */

const REPLY_WINDOW_MS = 24 * 3_600_000;
/** Unanswered fires in a row after which the job should ask, once. */
export const ASK_AFTER_IGNORED = 3;

export type FireReception = {
  startedMs: number;
  sends: string[];
  replied: boolean;
};

type Row = { from_me: number; text: string | null; body: Uint8Array | null; date: number };

const toNs = (ms: number) => (ms - 978_307_200_000) * 1_000_000;

export function fireReceptions(
  chatDb: ChatDb,
  chatGuid: string,
  windows: Array<{ startedMs: number; endedMs: number }>,
  nowMs = Date.now(),
): FireReception[] {
  const sql = `SELECT m.is_from_me AS from_me, m.text AS text, m.attributedBody AS body, m.date AS date
                 FROM message m
                 JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                 JOIN chat c ON c.ROWID = cmj.chat_id
                WHERE c.guid = ? AND m.date >= ? AND m.date < ?
                  AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
                ORDER BY m.date`;
  return windows.map((w, i) => {
    // Delivery can land a little after the model returns.
    const sendEnd = w.endedMs + 90_000;
    const next = windows[i + 1]?.startedMs ?? nowMs;
    const replyEnd = Math.min(next, sendEnd + REPLY_WINDOW_MS);
    const rows = chatDb.query<Row>(sql).all(chatGuid, toNs(w.startedMs), toNs(replyEnd));
    const sends: string[] = [];
    let replied = false;
    for (const r of rows) {
      const at = r.date / 1_000_000 + 978_307_200_000;
      if (r.from_me === 1 && at <= sendEnd) sends.push(decodeMessageText(r.text, r.body));
      else if (r.from_me === 0 && at > w.startedMs) replied = true;
    }
    return { startedMs: w.startedMs, sends, replied };
  });
}

function clip(t: string, n: number): string {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Fires that sent something and got no answer, counted back from the newest. */
export function trailingIgnored(receptions: FireReception[]): number {
  let n = 0;
  for (let i = receptions.length - 1; i >= 0; i--) {
    const r = receptions[i]!;
    if (r.sends.length === 0) continue;
    if (r.replied) break;
    n++;
  }
  return n;
}

/** The envelope block, or null when the job has no history yet. */
export function receptionBlock(receptions: FireReception[]): string | null {
  const sent = receptions.filter((r) => r.sends.length > 0);
  if (sent.length === 0) return null;
  const lines = ["How this job's recent sends landed (oldest first):"];
  for (const r of sent) {
    lines.push(
      `- ${envelopeStamp(new Date(r.startedMs))} · sent: "${clip(r.sends.join(" / "), 220)}" · ${r.replied ? "they replied" : "no reply"}`,
    );
  }
  const ignored = trailingIgnored(receptions);
  lines.push(
    "",
    "Do not send anything listed above again unless it changed (a posting already sent is not news; a new deadline or a status change is).",
  );
  if (ignored >= ASK_AFTER_IGNORED + 1) {
    lines.push(
      `The last ${ignored} sends got no reply, including after you asked. Stay quiet this time (reply KEEP_QUIET) and pause this job with the cron tools; mention it next time they write.`,
    );
  } else if (ignored >= ASK_AFTER_IGNORED) {
    lines.push(
      `The last ${ignored} sends got no reply. Instead of another one like them, ask once in one short line whether they still want this, and offer to change it or stop.`,
    );
  }
  return lines.join("\n");
}
