import { z } from "zod";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import { type HistoryLine, getRecentMessages } from "../imessage/history.ts";
import { runModelOneShot } from "../model/one-shot.ts";
import { readPersonFile } from "../persona/crud.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { type SessionKey, chatIdFromKey } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import { getSpendLedger, recordSpend } from "../spend/ledger.ts";
import { easternDate, easternDateTime } from "../util/clock.ts";
import { verifyRecurrence } from "./recurrence.ts";
import { type IdeationStore, type InterestThread, threadKey } from "./store.ts";

/**
 * The ideator: reads a month of one person's conversation with Edmund, finds
 * the interests they keep coming back to, and names the one page worth
 * building for them. The model groups and proposes; everything that decides
 * whether anything is built is code (see `pickCandidate`).
 *
 * Why this exists: on 2026-11-03 three people who text Edmund daily had
 * asked about the same subjects on six or more separate days each (one about
 * the sky: sunsets, the moon, light years, stargazing gear) and every answer
 * was a text message. In the 60 days before, Edmund built 17 interactive
 * pages across 81 chats, none for them.
 */

export const WINDOW_DAYS = 30;
export const MIN_DAYS = 3;
/** Not the same thread twice in this long. */
export const THREAD_COOLDOWN_DAYS = 21;
/** One build per person in this long. */
export const PERSON_COOLDOWN_DAYS = 7;
const DAY = 86_400_000;
const MODEL_TIMEOUT_MS = 300_000;
/** Above this the transcript is cut: replies first, then the oldest lines. */
const TRANSCRIPT_BUDGET_CHARS = 160_000;

export const CATEGORIES = [
  "interest",
  "project",
  "career",
  "errand",
  "health",
  "legal",
  "grief",
  "relationship",
  "money",
] as const;
/** Never built unasked, however often they come up. */
export const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  "health",
  "legal",
  "grief",
  "relationship",
  "money",
]);

const ThreadOut = z.object({
  label: z.string().min(2).max(80),
  category: z.enum(CATEGORIES),
  evidence: z.array(z.number()).max(80),
});
const CandidateOut = z.object({
  thread: z.string().min(2).max(80),
  title: z.string().min(3).max(80),
  pitch: z.string().min(10).max(300),
  why: z.string().min(10).max(600),
  brief: z.string().min(80).max(6000),
});
const Output = z.object({
  threads: z.array(ThreadOut).max(15),
  candidates: z.array(CandidateOut).max(3),
  reason: z.string().max(1500),
});
export type IdeatorOutput = z.infer<typeof Output>;

export type VerifiedThread = {
  label: string;
  category: string;
  days: string[];
  recurs: boolean;
  excluded: string | null;
  accepted: number[];
  rejected: number;
};

export type Pick = {
  thread: string;
  threadKey: string;
  title: string;
  pitch: string;
  why: string;
  brief: string;
  evidence: number[];
  days: string[];
};

export type IdeatorResult = {
  /** "picked" | "none" | "skipped" | "failed" */
  outcome: "picked" | "none" | "skipped" | "failed";
  reason: string;
  costUsd: number | null;
  threads: VerifiedThread[];
  pick: Pick | null;
  /** Candidates the gates turned down, and why. */
  turnedDown: Array<{ title: string; thread: string; why: string }>;
  /** The model's last answer, kept only when it could not be used. */
  raw?: string;
};

export type IdeatorDeps = {
  config: Config;
  chatDb: ChatDb;
  contacts: ContactBook;
  store: IdeationStore;
};

// ─── the transcript ────────────────────────────────────────────────────

/** A month of the conversation, their lines numbered by chat.db row so they can be cited. */
export function buildTranscript(
  chatDb: ChatDb,
  chatGuids: string[],
  sinceMs: number,
  untilMs: number,
): { text: string; theirLines: number } {
  const byRow = new Map<number, HistoryLine>();
  for (const guid of chatGuids) {
    for (const l of getRecentMessages(chatDb, guid, Number.MAX_SAFE_INTEGER, 4000)) {
      if (l.timestampMs >= sinceMs && l.timestampMs <= untilMs && !l.isTapback)
        byRow.set(l.rowId, l);
    }
  }
  const lines = [...byRow.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  const clean = (s: string) => s.replace(/￼/g, "[attachment]").replace(/\s+/g, " ").trim();
  const render = (replyChars: number, from: number) =>
    lines
      .slice(from)
      .map((l) => {
        const at = easternDateTime(new Date(l.timestampMs));
        if (l.fromMe) {
          const t = clean(l.text);
          return `      ${at} Edmund: ${t.length > replyChars ? `${t.slice(0, replyChars)}…` : t}`;
        }
        return `#${l.rowId} ${at} Them: ${clean(l.text).slice(0, 700)}`;
      })
      .join("\n");
  let text = render(220, 0);
  if (text.length > TRANSCRIPT_BUDGET_CHARS) text = render(90, 0);
  let from = 0;
  while (text.length > TRANSCRIPT_BUDGET_CHARS && from < lines.length) {
    from += Math.ceil(lines.length / 20);
    text = render(90, from);
  }
  return { text, theirLines: lines.slice(from).filter((l) => !l.fromMe).length };
}

/** The two sections of the person file that say who they are and what they reject. */
export function personExcerpt(body: string): string {
  const want = /^## (Operating Principles|Who They Are)\b/;
  const out: string[] = [];
  let keep = false;
  for (const line of body.split("\n")) {
    if (/^## /.test(line)) keep = want.test(line);
    if (keep) out.push(line);
  }
  return out.join("\n").slice(0, 8000);
}

// ─── the prompt ────────────────────────────────────────────────────────

export const IDEATOR_SYSTEM = `You work beside Edmund, an AI assistant people text over iMessage. Edmund answers fast and well, but always in text, so the people who use him only ever see text answers. Your job is to find what one person keeps coming back to and decide whether Edmund should build them something for it, unasked: an interactive web page that does what a text reply cannot.

You get a month of their conversation. Their messages are numbered (#row). Edmund's replies are not numbered and are cut short.

1. THREADS. Group their messages into the interests underneath them, by meaning, not by wording. "The night sky" covers sunsets, the moon, light years, a star's age and stargazing gear, even when no two messages share a word. A follow-up ("what about the smaller ranges?") belongs to the thread it follows. For each thread, cite the row numbers of ALL of their messages in it. Cite only numbered lines. Never invent a number.

   Give each thread a category:
   interest (a subject they are curious about), project (something they are making or planning: a trip, a channel, a renovation), career (jobs, interviews, applications), errand (a one-off task: a part, a purchase, a booking), health (bodies, symptoms, medication, weight, medical records), legal (courts, police, records, disputes), grief (death and loss, including pets), relationship (conflict or trouble between people), money (their debts, bills, budget, pay, taxes).
   Label health, legal, grief, relationship and money threads honestly. They are never built, however often they come up.

2. CANDIDATES. Up to three, best first, each for a thread that came up on several separate days. A good candidate:
   - is interactive: an explorer, a simulator, a planner, a map, a calculator, a practice tool, a tracker;
   - is made from THEIR material: the questions they asked, the places they named, the numbers and photos already in the conversation;
   - would get opened twice, and shows them something Edmund can do that they have not thought to ask for.
   Not a summary of the replies, not a document, not a list of links, not a shopping comparison. If nothing deserves a page, give no candidates and say why.

   title: what it is called, at most a few words. pitch: one sentence, what it is. why: why it goes past what the text replies already gave them, naming the thread's days.
   brief: for a web developer who has never seen the chat. Say what to build: sections, interactions, what is computed in the page (sun times, distances, costs) and what is baked in. List the specific facts, places, numbers and dates from the conversation it must use. Say what is unverified and must be labelled so. Carry the person's own rules that matter (from their notes). No phone numbers, emails, street addresses, or other people's private details.

3. Pages already built are listed. Do not propose a thread built in the last three weeks.

Reply with JSON only, no prose around it:
{"threads":[{"label":"...","category":"interest","evidence":[123,456]}],"candidates":[{"thread":"<a label from threads>","title":"...","pitch":"...","why":"...","brief":"..."}],"reason":"why these, or why nothing"}`;

export function ideatorInput(args: {
  name: string;
  today: string;
  excerpt: string;
  built: Array<{ title: string; thread: string; created: string }>;
  transcript: string;
}): string {
  const built =
    args.built.length === 0
      ? "(none yet)"
      : args.built.map((b) => `- ${b.created}: "${b.title}" (thread: ${b.thread})`).join("\n");
  return [
    `Person: ${args.name}`,
    `Today: ${args.today}`,
    "",
    "Their notes (Edmund's file on them):",
    args.excerpt || "(no notes)",
    "",
    "Pages already built for them:",
    built,
    "",
    `The last ${WINDOW_DAYS} days of the conversation:`,
    args.transcript,
  ].join("\n");
}

export function parseIdeatorOutput(raw: string): IdeatorOutput | null {
  const r = readIdeatorOutput(raw);
  return "out" in r ? r.out : null;
}

/** The parsed answer, or what is wrong with it in words the model can fix. */
export function readIdeatorOutput(raw: string): { out: IdeatorOutput } | { error: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "there is no JSON object in the answer" };
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return { error: `the JSON does not parse (${(err as Error).message})` };
  }
  const r = Output.safeParse(json);
  if (r.success) return { out: r.data };
  const issues = r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { error: `the JSON does not match the schema: ${issues}` };
}

// ─── the gates ─────────────────────────────────────────────────────────

/**
 * Check every thread against chat.db, then take the first candidate that
 * passes every gate. The model's ranking decides the order; it never decides
 * whether something passes.
 */
export function pickCandidate(
  out: IdeatorOutput,
  ctx: {
    chatDb: ChatDb;
    chatGuids: string[];
    nowMs: number;
    /** When a non-failed page was last made for this thread, by thread key. */
    lastBuiltMs: (threadKey: string) => number | null;
  },
): { threads: VerifiedThread[]; pick: Pick | null; turnedDown: IdeatorResult["turnedDown"] } {
  const rule = { nowMs: ctx.nowMs, windowDays: WINDOW_DAYS, minDays: MIN_DAYS };
  const threads: VerifiedThread[] = out.threads.map((t) => {
    const check = verifyRecurrence(ctx.chatDb, ctx.chatGuids, t.evidence, rule);
    return {
      label: t.label,
      category: t.category,
      days: check.days,
      recurs: check.ok,
      excluded: EXCLUDED_CATEGORIES.has(t.category) ? t.category : null,
      accepted: check.accepted,
      rejected: check.rejected.length,
    };
  });
  const byKey = new Map(threads.map((t) => [threadKey(t.label), t]));
  const turnedDown: IdeatorResult["turnedDown"] = [];
  for (const c of out.candidates) {
    const key = threadKey(c.thread);
    const t = byKey.get(key);
    const no = (why: string) => turnedDown.push({ title: c.title, thread: c.thread, why });
    if (!t) {
      no("its thread is not among the threads");
      continue;
    }
    if (t.excluded) {
      no(`the thread is ${t.excluded}, which is never built unasked`);
      continue;
    }
    if (!t.recurs) {
      no(`their messages span ${t.days.length} day(s), fewer than ${MIN_DAYS}`);
      continue;
    }
    const last = ctx.lastBuiltMs(key);
    if (last !== null && ctx.nowMs - last < THREAD_COOLDOWN_DAYS * DAY) {
      no(`a page for this thread was made ${Math.floor((ctx.nowMs - last) / DAY)} day(s) ago`);
      continue;
    }
    return {
      threads,
      turnedDown,
      pick: {
        thread: t.label,
        threadKey: key,
        title: c.title,
        pitch: c.pitch,
        why: c.why,
        brief: c.brief,
        evidence: t.accepted,
        days: t.days,
      },
    };
  }
  return { threads, pick: null, turnedDown };
}

/** All ideation spend in the 7 days to `nowMs`, every person together. */
export function weeklyIdeationSpend(dataDir: string, nowMs: number): number {
  return getSpendLedger(dataDir)
    .daily(7, nowMs)
    .filter((r) => r.subsystem === "ideation")
    .reduce((s, r) => s + r.costUsd, 0);
}

/** Whether this person may get an ideator pass at all, before any model is called. */
export function mayRun(
  deps: IdeatorDeps,
  sessionKey: SessionKey,
  nowMs: number,
): { ok: true } | { ok: false; why: string } {
  const recent = deps.store.buildsSince(sessionKey, nowMs - PERSON_COOLDOWN_DAYS * DAY);
  if (recent > 0)
    return { ok: false, why: `built for them in the last ${PERSON_COOLDOWN_DAYS} days` };
  const spent = weeklyIdeationSpend(deps.config.paths.data_dir, nowMs);
  if (spent >= deps.config.ideation.weekly_budget_usd) {
    return {
      ok: false,
      why: `weekly budget spent ($${spent.toFixed(2)} of $${deps.config.ideation.weekly_budget_usd})`,
    };
  }
  return { ok: true };
}

// ─── the pass ──────────────────────────────────────────────────────────

/**
 * One ideator pass for one person. `asOfMs` replays the past: the
 * transcript, the recurrence window and the list of earlier pages all stop
 * there. `dryRun` records nothing (no spend row, no run row, no threads).
 */
export async function runIdeator(
  deps: IdeatorDeps,
  sessionKey: SessionKey,
  opts: { asOfMs?: number; dryRun?: boolean } = {},
): Promise<IdeatorResult> {
  const nowMs = opts.asOfMs ?? Date.now();
  const handle = chatIdFromKey(sessionKey);
  const chatGuids = chatGuidsForSession(sessionKey, deps.chatDb, deps.contacts);
  const empty = (outcome: IdeatorResult["outcome"], reason: string): IdeatorResult => ({
    outcome,
    reason,
    costUsd: null,
    threads: [],
    pick: null,
    turnedDown: [],
  });
  if (chatGuids.length === 0) return empty("skipped", "no chat for this session");

  const transcript = buildTranscript(deps.chatDb, chatGuids, nowMs - WINDOW_DAYS * DAY, nowMs);
  if (transcript.theirLines < MIN_DAYS) return empty("skipped", "too little conversation");
  const person = readPersonFile(handle);
  const built = deps.store
    .listForSession(sessionKey)
    .filter((i) => i.createdMs <= nowMs && i.status !== "failed")
    .map((i) => ({
      title: i.title,
      thread: i.thread,
      created: easternDate(new Date(i.createdMs)),
    }));
  const name =
    deps.contacts.displayName(handle) ?? person?.body.match(/^# (.+)$/m)?.[1]?.trim() ?? "them";

  const model = deps.config.ideation.model;
  const input = ideatorInput({
    name,
    today: easternDate(new Date(nowMs)),
    excerpt: person ? personExcerpt(person.body) : "",
    built,
    transcript: transcript.text,
  });
  const call = async (text: string) => {
    const r = await runModelOneShot({
      args: [
        "--model",
        model,
        "--permission-mode",
        "bypassPermissions",
        "--append-system-prompt",
        IDEATOR_SYSTEM,
      ],
      input: text,
      timeoutMs: MODEL_TIMEOUT_MS,
    });
    if (!opts.dryRun) {
      recordSpend(deps.config.paths.data_dir, {
        sessionKey,
        subsystem: "ideation",
        model: r.model ?? model,
        costUsd: r.costUsd,
        durMs: r.durationMs,
      });
    }
    return r;
  };

  // One retry when the answer is malformed, told exactly what was wrong: a
  // schema refused at parse time is a fixable mistake, not a reason to skip
  // the person until tomorrow.
  let cost = 0;
  let out: IdeatorOutput | null = null;
  let lastError = "";
  let raw = "";
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const r = await call(
      attempt === 0
        ? input
        : `${input}\n\nYour previous answer could not be used: ${lastError}. Reply again with the JSON only.`,
    );
    cost += r.costUsd ?? 0;
    if (!r.ok) {
      return { ...empty("failed", `model call failed: ${r.error ?? "unknown"}`), costUsd: cost };
    }
    raw = r.text;
    const read = readIdeatorOutput(r.text);
    if ("out" in read) out = read.out;
    else lastError = read.error;
  }
  if (!out) {
    return {
      ...empty("failed", `the model's answer was unusable twice: ${lastError}`),
      costUsd: cost,
      raw,
    };
  }

  const { threads, pick, turnedDown } = pickCandidate(out, {
    chatDb: deps.chatDb,
    chatGuids,
    nowMs,
    lastBuiltMs: (key) => {
      const last = deps.store.lastForThread(sessionKey, key);
      return last && last.createdMs <= nowMs ? last.createdMs : null;
    },
  });

  if (!opts.dryRun) {
    const summary: InterestThread[] = threads
      .filter((t) => !t.excluded && t.days.length > 0)
      .map((t) => ({
        label: t.label,
        days: t.days,
        lastSeenMs: lastSeen(t.days),
        excluded: null,
      }));
    deps.store.saveThreads(sessionKey, summary, nowMs);
  }

  return {
    outcome: pick ? "picked" : "none",
    reason: out.reason,
    costUsd: cost,
    threads,
    pick,
    turnedDown,
  };
}

function lastSeen(days: string[]): number {
  const last = days[days.length - 1];
  return last ? Date.parse(`${last}T12:00:00-05:00`) : 0;
}
