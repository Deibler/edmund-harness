import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_SENTINELS } from "../channels/sanitize-outbound.ts";
import type { ChatDb } from "../imessage/db.ts";
import { decodeMessageText } from "../imessage/decode.ts";

/**
 * The weekly review: a handful of numbers from the systems of record and a
 * sample of real exchanges to read and mark pass or fail. The judge in
 * evals/ scores tone, length and persona on about seven transcripts a week;
 * none of the gaps found on 2026-10-25 (stale facts, guesses from unread
 * pages, scheduled texts nobody answered, leaked control words) was that
 * kind, and every one of them was found by reading conversations. This makes
 * that reading a weekly habit with the counts beside it.
 *
 * Read-only: chat.db, state.db and daemon.log. The sheet goes to
 * data/reviews/, which is private to this machine.
 */

export type ReviewMsg = { fromMe: boolean; text: string; ms: number };

export type ReplyStats = {
  bursts: number;
  answered: number;
  unanswered24h: number;
  latenciesMs: number[];
};

/**
 * Inbound bursts (consecutive messages from others) and how long each waited
 * for the assistant's next message. Waiting is measured from the burst's
 * first message: that is how long the person waited.
 */
export function replyStats(msgs: ReviewMsg[], nowMs: number): ReplyStats {
  const out: ReplyStats = { bursts: 0, answered: 0, unanswered24h: 0, latenciesMs: [] };
  let burstStart: number | null = null;
  for (const m of msgs) {
    if (!m.fromMe) {
      if (burstStart === null) burstStart = m.ms;
      continue;
    }
    if (burstStart !== null) {
      out.bursts++;
      out.answered++;
      out.latenciesMs.push(m.ms - burstStart);
      burstStart = null;
    }
  }
  if (burstStart !== null) {
    out.bursts++;
    if (nowMs - burstStart > 24 * 3_600_000) out.unanswered24h++;
  }
  return out;
}

/** Things people say when the assistant got it wrong. Every hit is listed in
 *  the sheet to be read; the count alone proves nothing. */
const CORRECTION_RE =
  /\b(that'?s (not right|wrong|incorrect)|not what i (asked|said|meant)|i (already|just) (told|said|sent)|you('re| are) wrong|wrong (person|one|file|link|day|date)|that'?s not (it|true)|no,? (that'?s|it'?s|i said)|did(n'?t| not) ask (for|you)|stop (sending|doing)|why did you)\b/i;

export function isCorrection(text: string): boolean {
  return CORRECTION_RE.test(text);
}

const LEAK_RE = new RegExp(`\\b(?:${CONTROL_SENTINELS.join("|")})\\b`);

export function isLeak(text: string): boolean {
  return LEAK_RE.test(text);
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

/** Counts of the log lines that mark background work failing or helping. */
export const LOG_SIGNALS: Array<{ label: string; re: RegExp }> = [
  { label: "scheduled job failed", re: /\[cron\] fire failed/ },
  { label: "scheduled job gave up after retries", re: /retries exhausted/ },
  { label: "memory note pass failed", re: /\[persona-maintainer\] model call failed/ },
  { label: "consolidation failed, archive held", re: /pass failed, archive held/ },
  { label: "message shown to a running turn", re: /\[mid-turn\] shown to the running turn/ },
  { label: "background result joined a running turn", re: /result joined the running turn/ },
  { label: "operator alert sent", re: /\[alert\] sent to/ },
];

export function countLogSignals(logText: string, sinceIso: string): Map<string, number> {
  const counts = new Map(LOG_SIGNALS.map((s) => [s.label, 0]));
  for (const line of logText.split("\n")) {
    if (line.slice(0, 24) < sinceIso) continue;
    for (const s of LOG_SIGNALS) {
      if (s.re.test(line)) counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
    }
  }
  return counts;
}

type Chat = { sessionKey: string; chatGuid: string; isGroup: boolean };

function listChats(dataDir: string): Chat[] {
  const path = join(dataDir, "state.db");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return (
      db.query("SELECT session_key, chat_guid, is_group FROM sessions").all() as Array<{
        session_key: string;
        chat_guid: string;
        is_group: number;
      }>
    )
      .filter((r) => /(^|:)(dm|group):/.test(r.session_key))
      .map((r) => ({ sessionKey: r.session_key, chatGuid: r.chat_guid, isGroup: r.is_group === 1 }));
  } finally {
    db.close();
  }
}

function loadMessages(chatDb: ChatDb, chatGuid: string, sinceMs: number): ReviewMsg[] {
  const sinceNs = (sinceMs - 978_307_200_000) * 1_000_000;
  const rows = chatDb
    .query<{ text: string | null; body: Uint8Array | null; from_me: number; date: number }>(
      `SELECT m.text AS text, m.attributedBody AS body, m.is_from_me AS from_me, m.date AS date
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE c.guid = ? AND m.date >= ?
          AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
        ORDER BY m.date`,
    )
    .all(chatGuid, sinceNs);
  return rows.map((r) => ({
    fromMe: r.from_me === 1,
    text: decodeMessageText(r.text, r.body),
    ms: r.date / 1_000_000 + 978_307_200_000,
  }));
}

/** Exchanges to read: an inbound burst and what the assistant said next. */
function exchanges(msgs: ReviewMsg[]): Array<{ asked: string; reply: string; ms: number }> {
  const out: Array<{ asked: string; reply: string; ms: number }> = [];
  let asked: string[] = [];
  let at = 0;
  for (const m of msgs) {
    if (!m.fromMe) {
      if (asked.length === 0) at = m.ms;
      asked.push(m.text);
    } else if (asked.length > 0) {
      out.push({ asked: asked.join(" / "), reply: m.text, ms: at });
      asked = [];
    }
  }
  return out;
}

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function minutes(ms: number | null): string {
  if (ms === null) return "n/a";
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

export function buildWeeklyReview(deps: {
  chatDb: ChatDb;
  dataDir: string;
  days: number;
  sample: number;
  nowMs?: number;
  label?: (sessionKey: string) => string;
}): string {
  const now = deps.nowMs ?? Date.now();
  const since = now - deps.days * 86_400_000;
  const label = deps.label ?? ((k: string) => k);
  const chats = listChats(deps.dataDir);

  const dmLatencies: number[] = [];
  let dmBursts = 0;
  let dmUnanswered = 0;
  const corrections: string[] = [];
  const leaks: string[] = [];
  const pool: Array<{ who: string; group: boolean; asked: string; reply: string; ms: number }> = [];
  for (const chat of chats) {
    const msgs = loadMessages(deps.chatDb, chat.chatGuid, since);
    if (msgs.length === 0) continue;
    if (!chat.isGroup) {
      const s = replyStats(msgs, now);
      dmBursts += s.bursts;
      dmUnanswered += s.unanswered24h;
      dmLatencies.push(...s.latenciesMs);
      for (const m of msgs) {
        if (!m.fromMe && isCorrection(m.text)) {
          corrections.push(`${label(chat.sessionKey)} · ${new Date(m.ms).toISOString().slice(0, 16)} · ${clip(m.text, 200)}`);
        }
      }
    }
    for (const m of msgs) {
      if (m.fromMe && isLeak(m.text)) {
        leaks.push(`${label(chat.sessionKey)} · ${new Date(m.ms).toISOString().slice(0, 16)} · ${clip(m.text, 200)}`);
      }
    }
    for (const x of exchanges(msgs)) {
      pool.push({ who: label(chat.sessionKey), group: chat.isGroup, ...x });
    }
  }

  // Half the sample from DMs, half from groups, spread across the week.
  const pick = (items: typeof pool, n: number) => {
    if (items.length <= n) return items;
    const step = items.length / n;
    return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]!);
  };
  const byTime = (a: { ms: number }, b: { ms: number }) => a.ms - b.ms;
  const dms = pool.filter((p) => !p.group).sort(byTime);
  const groups = pool.filter((p) => p.group).sort(byTime);
  const groupShare = Math.min(groups.length, Math.floor(deps.sample / 2));
  const sample = [...pick(dms, deps.sample - groupShare), ...pick(groups, groupShare)].sort(byTime);

  const logPath = join(deps.dataDir, "daemon.log");
  const signals = existsSync(logPath)
    ? countLogSignals(readFileSync(logPath, "utf8"), new Date(since).toISOString())
    : new Map<string, number>();

  const lines: string[] = [];
  const day = new Date(now).toISOString().slice(0, 10);
  lines.push(`# Weekly review ${day} (last ${deps.days} days)`, "");
  lines.push("## Numbers", "");
  lines.push(
    `- DM reply time: median ${minutes(percentile(dmLatencies, 50))}, p90 ${minutes(percentile(dmLatencies, 90))} (n=${dmLatencies.length} answered bursts of ${dmBursts}).`,
    `- DM bursts with no reply after 24 h: ${dmUnanswered}.`,
    `- Corrections from people: ${corrections.length} (read every one below).`,
    `- Control words that reached a person: ${leaks.length} (target 0).`,
  );
  for (const [k, v] of signals) lines.push(`- ${k}: ${v}`);
  lines.push("", "## Corrections", "");
  lines.push(...(corrections.length ? corrections.map((c) => `- ${c}`) : ["- none"]));
  lines.push("", "## Leaked control words", "");
  lines.push(...(leaks.length ? leaks.map((c) => `- ${c}`) : ["- none"]));
  lines.push(
    "",
    `## Sample (${sample.length} exchanges)`,
    "",
    "Mark each pass or fail. On a fail, write the FIRST thing that went wrong in a few words (a wrong fact, a guess presented as checked, forgot something they said, too long, missed the point, ignored a correction). Group the notes into categories at the end and count them.",
    "",
  );
  sample.forEach((x, i) => {
    lines.push(
      `### ${i + 1}. ${x.who}${x.group ? " (group)" : ""} · ${new Date(x.ms).toISOString().slice(0, 16)}`,
      `- **They:** ${clip(x.asked, 500)}`,
      `- **Edmund:** ${clip(x.reply, 700)}`,
      "- [ ] pass  [ ] fail — first failure:",
      "",
    );
  });
  lines.push("## Failure categories this week", "", "- ", "");
  return lines.join("\n");
}

export function writeWeeklyReview(dataDir: string, body: string, nowMs = Date.now()): string {
  const dir = join(dataDir, "reviews");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${new Date(nowMs).toISOString().slice(0, 10)}.md`);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}
