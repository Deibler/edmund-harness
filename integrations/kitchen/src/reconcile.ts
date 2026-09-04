/**
 * Checking the ledger against the actual shelves.
 *
 * Everything else in this integration is an inference. A receipt says what came
 * in, a confirmed meal says what went out, the decay engine guesses at what left
 * without being logged. All of it is careful and all of it drifts, because the
 * real kitchen is edited constantly by people who are not narrating: somebody
 * finishes the milk, a bag of greens turns, half a packet gets thrown out during
 * a clean-up. Drift is not a bug to be fixed once; it is the steady state.
 *
 * So there has to be a way to look. This is that: a pass over what the ledger
 * believes, item by item, answered by somebody standing in front of the fridge.
 *
 * THREE THINGS SHAPE THE DESIGN.
 *
 *   It must be faster than it is accurate. A perfect audit nobody finishes is
 *   worth less than a rough one done in ninety seconds, because the rough one
 *   happens again next week. One item per card, one gesture, no typing unless
 *   the answer genuinely needs a number.
 *
 *   It must be resumable and partial. Half a pass is a real improvement, so a
 *   session records answers as they come rather than at the end, and abandoning
 *   it mid-way keeps everything already answered.
 *
 *   It must say WHO looked. Two households share this code and three people
 *   share one of them. "The ledger says four onions" and "Jordan looked in the
 *   drawer on Sunday and counted four onions" are different facts, and the
 *   second one is the one worth keeping. Every verdict carries its principal.
 *
 * A CONFIRMATION IS EVIDENCE, NOT A NO-OP. Swiping right writes an event, even
 * though nothing about the quantity changed, because it moves the item's
 * `updated` timestamp forward. That is precisely what the decay engine reads:
 * somebody physically saw this on the shelf today, so stop counting it as
 * untouched. Without the write, a reconcile pass would leave the kitchen
 * looking staler than before it happened.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountDir } from "./accounts.ts";
import { amount, append, live, nowIso, readLog } from "./store.ts";
import type { Item } from "./types.ts";

/** What somebody standing at the shelf can say about one item. */
export type Verdict =
  | { kind: "have" }
  | { kind: "gone" }
  | { kind: "amount"; qty: number; unit?: string | null };

export type Answer = {
  item: string;
  verdict: Verdict;
  at: string;
  /** The principal who actually looked. Never inferred. */
  by: string | null;
};

export type Session = {
  id: string;
  /** Ledger slugs still to be answered, in the order they are shown. */
  queue: string[];
  answers: Answer[];
  started: string;
  /** Whose pass this is. A household can have more than one going. */
  by: string | null;
  /**
   * Where the queue came from, so the site can say why it is asking.
   * "photos" means a picture was read and this is the diff it proposed.
   */
  source: "shelf" | "photos" | "stale";
  /** For a photo pass: what the reading believed, per item, before answering. */
  proposed?: Record<string, Verdict>;
  /** Set once the answers have been written to the ledger. */
  applied?: string | null;
};

function sessionPath(account: string): string {
  return join(accountDir(), account, "reconcile.json");
}

export function readSessions(account: string): Session[] {
  const p = sessionPath(account);
  if (!existsSync(p)) return [];
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { sessions?: Session[] }).sessions ?? [];
  } catch {
    return [];
  }
}

function writeSessions(account: string, sessions: Session[]): void {
  const p = sessionPath(account);
  mkdirSync(dirname(p), { recursive: true });
  // Only the last few are kept. This is a working file, not a record: what a
  // pass concluded lives in the ledger, which is the thing that is permanent.
  writeFileSync(p, JSON.stringify({ sessions: sessions.slice(-6) }, null, 2));
}

/** The open pass for a person, if they have one. */
export function openSession(account: string, by?: string | null): Session | null {
  const all = readSessions(account);
  const mine = all.filter((s) => !s.applied && (by == null || s.by === by));
  return mine[mine.length - 1] ?? null;
}

/**
 * WHEN A HUMAN LAST LOOKED AT EACH THING, which is not the same as when it was
 * last touched.
 *
 * This distinction is the whole fix for "I finish a pass and the same items come
 * back". `updated` moves for any reason at all: a receipt, a meal, an automatic
 * cleanup. Only a `reconcile` event means somebody physically looked, and only
 * that should reset the clock on being asked again.
 */
function lastLooked(account: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of readLog(account)) {
    if (e.src !== "reconcile" || !e.item) continue;
    out.set(e.item, new Date(e.ts).getTime());
  }
  return out;
}

/**
 * Roughly how long a thing survives in this house, in days.
 *
 * Category default first, then the household's own history where it has any:
 * if these people have bought milk four times and it has lasted nine, eleven,
 * eight and ten days, then milk lasts ten days HERE, whatever a table says. The
 * history wins because it is about this kitchen and the table is about kitchens.
 */
const LIFE: Record<string, number> = {
  seafood: 4,
  meat: 6,
  produce: 12,
  bakery: 9,
  dairy: 18,
  other: 7,
  frozen: 120,
  snack: 40,
  drink: 30,
  pantry: 180,
  condiment: 200,
  spice: 400,
};

function observedLife(account: string): Map<string, number> {
  const firstSeen = new Map<string, number>();
  const qty = new Map<string, number>();
  const spans = new Map<string, number[]>();

  for (const e of readLog(account)) {
    if (!e.item) continue;
    const t = new Date(e.ts).getTime();
    const q = e.qty ?? null;

    if (e.op === "add") {
      if (!firstSeen.has(e.item)) firstSeen.set(e.item, t);
      qty.set(e.item, (qty.get(e.item) ?? 0) + (q ?? 1));
      continue;
    }
    if (e.op === "set") {
      qty.set(e.item, q ?? 1);
    } else if (e.op === "use" || e.op === "toss") {
      // A span closes when the thing is actually EMPTY, not on any use of it.
      // Closing on every use was badly wrong: cooking one dinner with egg
      // noodles "proved" that egg noodles last three days in this house, which
      // then read as a hazard of 2.5 and pushed a full bag of pasta to the top
      // of the deck ahead of the chicken.
      qty.set(e.item, q === null ? 0 : (qty.get(e.item) ?? 0) - q);
    } else continue;

    if ((qty.get(e.item) ?? 0) > 0) continue;
    const from = firstSeen.get(e.item);
    if (from === undefined) continue;
    const days = (t - from) / 86_400_000;
    if (days >= 0.5 && days < 400)
      (spans.get(e.item) ?? spans.set(e.item, []).get(e.item)!).push(days);
    firstSeen.delete(e.item);
  }

  const out = new Map<string, number>();
  for (const [id, xs] of spans) {
    // One span is an anecdote. Two is the beginning of a habit, and only then is
    // it better evidence than the category default it would be overriding.
    if (xs.length < 2) continue;
    // Median, not mean: one bag of rice bought in March and finished in August
    // should not convince the model that spinach lasts five months.
    const sorted = [...xs].sort((a, b) => a - b);
    out.set(id, sorted[Math.floor(sorted.length / 2)]!);
  }
  return out;
}

/**
 * How badly this item wants asking about, highest first.
 *
 * Three forces, deliberately different in kind:
 *
 *   HAZARD. How far through its expected life it is since anybody touched it.
 *   Past 1.0 it is statistically more likely gone than not, and that is where
 *   the ledger starts lying. This is what makes the deck open on the chicken.
 *
 *   DEBT. Days since a human actually LOOKED at it. This one has no ceiling, so
 *   even a jar of paprika that never spoils and never gets logged eventually
 *   climbs high enough to be asked about. That is what makes the pass get
 *   through everything rather than circling the same twenty perishables.
 *
 *   VALUE. Being wrong about chicken costs a dinner; being wrong about oregano
 *   costs nothing. Perishables are worth asking about sooner at equal odds.
 *
 * And one hard rule on top: something a human confirmed in the last few days is
 * not asked again, whatever the score. Re-asking a question somebody just
 * answered is the single fastest way to make a tool feel broken.
 */
const JUST_CHECKED_DAYS = 6;

export type Scored = { item: Item; score: number; hazard: number; sinceLooked: number | null };

export function scoreShelf(account: string, items: Item[], now = Date.now()): Scored[] {
  const DAY = 86_400_000;
  const looked = lastLooked(account);
  const observed = observedLife(account);
  const VALUE: Record<string, number> = {
    seafood: 1.6,
    meat: 1.55,
    produce: 1.45,
    dairy: 1.2,
    bakery: 1.2,
    other: 1.1,
    frozen: 0.8,
    snack: 0.7,
    drink: 0.7,
    pantry: 0.55,
    condiment: 0.4,
    spice: 0.35,
  };

  const out: Scored[] = [];
  for (const i of items) {
    const idle = (now - new Date(i.updated || i.added).getTime()) / DAY;
    const seenAt = looked.get(i.id) ?? null;
    const sinceLooked = seenAt === null ? null : (now - seenAt) / DAY;

    // Answered recently. Leave it alone; that is the point of having answered.
    if (sinceLooked !== null && sinceLooked < JUST_CHECKED_DAYS) continue;
    // Touched in the last two days by anything at all: a receipt or a meal is
    // its own kind of evidence and asking adds nothing.
    if (idle < 2) continue;

    const life = observed.get(i.id) ?? LIFE[i.cat] ?? 30;
    const hazard = Math.min(2.5, idle / Math.max(1, life));
    // Never looked at is worse than looked at long ago: it is the case where
    // the ledger has never once been confirmed by a person.
    const debt = sinceLooked === null ? Math.min(idle, 120) / 30 + 1 : sinceLooked / 30;

    let score = (VALUE[i.cat] ?? 1) * (hazard * 60) + debt * 22;
    // A level-tracked staple can only ever answer "gone", which is a rarer and
    // cheaper miss, so it waits its turn behind anything countable.
    if (i.qty === null) score *= 0.55;
    if (i.expires) {
      const left = (new Date(`${i.expires}T00:00:00`).getTime() - now) / DAY;
      if (left <= 0) score += 70;
      else if (left <= 5) score += 40;
    }
    out.push({ item: i, score, hazard, sinceLooked });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * How many cards one pass asks for.
 *
 * A hundred-item audit is a chore that gets abandoned at item nine, and the pass
 * somebody finishes teaches more than the pass they quit. The rest are not lost:
 * their debt keeps climbing, so they surface on their own.
 */
export const DECK_SIZE = 24;

/**
 * The deck: mostly what is most likely wrong, plus a slice of what has waited
 * longest to be seen at all.
 *
 * The reserved tail matters more than it looks. Pure score ordering is a
 * perishables treadmill: the fridge gets checked every week and the back of the
 * pantry is never checked once, because a bag of lentils never scores. Holding
 * back a quarter of the deck for whatever has gone longest without a human
 * looking means the whole kitchen gets covered eventually, without giving up the
 * urgency at the front.
 */
export function checkOrder(
  items: Item[],
  now = Date.now(),
  limit = DECK_SIZE,
  account?: string,
): Item[] {
  if (!account) {
    // Kept for callers that only have a list. Ordering without the log cannot
    // know what was checked, so it degrades to hazard by category.
    return [...items]
      .filter((i) => (now - new Date(i.updated || i.added).getTime()) / 86_400_000 >= 2)
      .sort(
        (a, b) =>
          new Date(a.updated || a.added).getTime() - new Date(b.updated || b.added).getTime(),
      )
      .slice(0, limit);
  }
  const scored = scoreShelf(account, items, now);
  const urgentN = Math.ceil(limit * 0.75);
  const urgent = scored.slice(0, urgentN);
  const taken = new Set(urgent.map((s) => s.item.id));
  const neglected = scored
    .filter((s) => !taken.has(s.item.id))
    .sort((a, b) => (b.sinceLooked ?? 9e9) - (a.sinceLooked ?? 9e9))
    .slice(0, limit - urgent.length);
  return [...urgent, ...neglected].map((s) => s.item);
}

export function startSession(
  account: string,
  opts: {
    by?: string | null;
    source?: Session["source"];
    only?: string[];
    proposed?: Record<string, Verdict>;
  } = {},
): Session {
  const stock = live(account);
  const byId = new Map(stock.map((i) => [i.id, i]));
  const queue = opts.only?.length
    ? opts.only.filter((id) => byId.has(id))
    : checkOrder(stock, Date.now(), DECK_SIZE, account).map((i) => i.id);

  const s: Session = {
    id: `rc-${Date.now().toString(36)}`,
    queue,
    answers: [],
    started: nowIso(),
    by: opts.by ?? null,
    source: opts.source ?? "shelf",
    proposed: opts.proposed,
    applied: null,
  };
  // One open pass per person. Starting a new one abandons whatever they left
  // half-finished, which is the right call: a queue built from last week's
  // shelves is asking about a kitchen that has moved on.
  const others = readSessions(account).filter((x) => x.applied || x.by !== s.by);
  writeSessions(account, [...others, s]);
  return s;
}

/**
 * Find a pass by id, creating it if the page invented the id itself.
 *
 * The swipe deck generates its own session id and starts answering immediately,
 * with no round trip to ask permission first. That is deliberate: a page that
 * has to negotiate before the first swipe is a page that feels broken on a slow
 * kitchen wifi, and the id only has to be unique, not blessed. Sessions created
 * this way carry no queue, because the deck already knows the order it is
 * asking in; the queue only matters for the version I drive over text.
 */
export function ensureSession(
  account: string,
  id: string,
  by: string | null,
  source: Session["source"] = "shelf",
): Session {
  const all = readSessions(account);
  const found = all.find((x) => x.id === id);
  if (found) return found;
  const s: Session = {
    id,
    queue: [],
    answers: [],
    started: nowIso(),
    by,
    source,
    applied: null,
  };
  writeSessions(account, [...all, s]);
  return s;
}

/** Record one verdict. Returns the session, or null if it has gone. */
export function answer(
  account: string,
  sessionId: string,
  item: string,
  verdict: Verdict,
  by: string | null,
): Session | null {
  const all = readSessions(account);
  const s = all.find((x) => x.id === sessionId);
  if (!s || s.applied) return null;
  // Answering the same item twice keeps the LAST answer. Somebody who swiped
  // then went back to correct themselves means the correction.
  s.answers = s.answers.filter((a) => a.item !== item);
  s.answers.push({ item, verdict, at: nowIso(), by });
  s.queue = s.queue.filter((id) => id !== item);
  writeSessions(account, all);
  return s;
}

export type Applied = {
  confirmed: number;
  removed: Array<{ id: string; name: string }>;
  corrected: Array<{ id: string; name: string; from: string; to: string }>;
  batch: string | null;
};

/**
 * Write a pass into the ledger, in one retractable batch.
 *
 * Every answer produces an event, including the boring ones. A confirmation is
 * the whole reason the pass is worth doing: it is the only evidence in the
 * system that a human eye actually saw the thing, and it is what stops the
 * decay engine retiring food that is sitting right there.
 */
export function applySession(account: string, sessionId: string): Applied | null {
  const all = readSessions(account);
  const s = all.find((x) => x.id === sessionId);
  if (!s || s.applied || !s.answers.length) return null;

  const items = Object.fromEntries(live(account).map((i) => [i.id, i]));
  const who = s.by ? ` (${s.by})` : "";
  const out: Applied = { confirmed: 0, removed: [], corrected: [], batch: null };
  const events: Parameters<typeof append>[1] = [];

  for (const a of s.answers) {
    const it = items[a.item];
    if (!it) continue;
    if (a.verdict.kind === "have") {
      out.confirmed++;
      // Same numbers, new timestamp. The point is the timestamp.
      events.push({
        op: "set",
        item: a.item,
        qty: it.qty,
        unit: it.unit,
        fields: {},
        why: `checked the shelf${who}`,
        src: "reconcile",
      });
    } else if (a.verdict.kind === "gone") {
      out.removed.push({ id: it.id, name: it.name });
      events.push({
        op: "use",
        item: a.item,
        qty: null,
        fields: {},
        why: `not on the shelf${who}`,
        src: "reconcile",
      });
    } else {
      const to = `${a.verdict.qty}${(a.verdict.unit ?? it.unit) ? ` ${a.verdict.unit ?? it.unit}` : ""}`;
      out.corrected.push({ id: it.id, name: it.name, from: amount(it), to });
      events.push({
        op: "set",
        item: a.item,
        qty: a.verdict.qty,
        unit: a.verdict.unit ?? it.unit,
        fields: {},
        why: `counted on the shelf${who}`,
        src: "reconcile",
      });
    }
  }
  if (!events.length) return null;

  out.batch = append(account, events);
  s.applied = nowIso();
  writeSessions(account, all);
  return out;
}

/** How far through a pass somebody is, for a progress bar and a sentence. */
export function progress(s: Session): { done: number; left: number; total: number } {
  const done = s.answers.length;
  return { done, left: s.queue.length, total: done + s.queue.length };
}

/**
 * The last time anybody actually looked, and who.
 *
 * Shown on the site because a stock list is only as trustworthy as its last
 * check, and a number with no date next to it invites more confidence than it
 * has earned.
 */
export function lastChecked(account: string): { at: string; by: string | null } | null {
  const done = readSessions(account).filter((s) => s.applied);
  const last = done[done.length - 1];
  return last?.applied ? { at: last.applied, by: last.by } : null;
}
