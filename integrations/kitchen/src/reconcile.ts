/**
 * The shelf check: a person confirms, corrects or removes items one card at a
 * time, and the answers are written to the ledger in one batch.
 *
 * Design constraints:
 *   - Fast over thorough: one gesture per card, a deck of at most `DECK_SIZE`.
 *   - Resumable: answers are saved as they arrive, so half a pass still counts.
 *   - Attributed: every verdict records who looked.
 *
 * A confirmation writes an event too. It is the only evidence that a person
 * saw the item, and it refreshes the item's last-seen time for inventory
 * reasoning.
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
  /** The principal who looked. Never inferred. */
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
  /** Where the queue came from; "photos" means a picture was read and this is its diff. */
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
  // A working file; the ledger is the record. Keep only the last few.
  writeFileSync(p, JSON.stringify({ sessions: sessions.slice(-6) }, null, 2));
}

/** The open pass for a person, if they have one. */
export function openSession(account: string, by?: string | null): Session | null {
  const all = readSessions(account);
  const mine = all.filter((s) => !s.applied && (by == null || s.by === by));
  return mine[mine.length - 1] ?? null;
}

/**
 * When a person last looked at each item: only `reconcile` events count, since
 * `updated` moves for receipts and meals too. This is what stops a finished
 * pass from asking about the same items again.
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
 * Rough life in days by category, used to order the deck. The household's own
 * observed life (`observedLife`) wins where it has enough history.
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
      // A span closes only when the item is empty, not on every use.
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
    // At least two spans before overriding the category default; median resists
    // one long outlier.
    if (xs.length < 2) continue;
    const sorted = [...xs].sort((a, b) => a - b);
    out.set(id, sorted[Math.floor(sorted.length / 2)]!);
  }
  return out;
}

/**
 * How much each item is worth asking about, highest first. Three terms:
 *   hazard: how far through its expected life it is since last touched;
 *   debt:   days since a person looked, uncapped, so everything is reached
 *           eventually;
 *   value:  perishables cost more to be wrong about than spices.
 * Anything a person confirmed within `JUST_CHECKED_DAYS` is not asked again.
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

    if (sinceLooked !== null && sinceLooked < JUST_CHECKED_DAYS) continue;
    // Touched in the last two days (a receipt, a meal): asking adds nothing.
    if (idle < 2) continue;

    const life = observed.get(i.id) ?? LIFE[i.cat] ?? 30;
    const hazard = Math.min(2.5, idle / Math.max(1, life));
    // Never looked at scores above looked at long ago.
    const debt = sinceLooked === null ? Math.min(idle, 120) / 30 + 1 : sinceLooked / 30;

    let score = (VALUE[i.cat] ?? 1) * (hazard * 60) + debt * 22;
    // Level-tracked staples can only be "gone", a cheaper miss: ask them later.
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

/** Cards per pass. Short enough to finish; the rest surface later as their debt grows. */
export const DECK_SIZE = 24;

/**
 * The deck: three quarters by score, one quarter reserved for whatever has gone
 * longest without a person looking, so the pantry gets checked eventually and
 * not only the fridge.
 */
export function checkOrder(
  items: Item[],
  now = Date.now(),
  limit = DECK_SIZE,
  account?: string,
): Item[] {
  if (!account) {
    // Without the log, fall back to oldest-touched first.
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
  // One open pass per person: a new one replaces their unfinished one.
  const others = readSessions(account).filter((x) => x.applied || x.by !== s.by);
  writeSessions(account, [...others, s]);
  return s;
}

/**
 * Find a pass by id, creating it when the page chose the id itself. The swipe
 * deck names its own session so the first swipe needs no round trip; such
 * sessions have no queue because the page holds the order.
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
  // A second answer for the same item replaces the first.
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
 * Write a pass to the ledger in one retractable batch. Confirmations are
 * written too: they are the evidence that a person saw the item.
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
      // Same numbers; the write records the look.
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

/** When the last shelf check was applied, and by whom. Shown on the site. */
export function lastChecked(account: string): { at: string; by: string | null } | null {
  const done = readSessions(account).filter((s) => s.applied);
  const last = done[done.length - 1];
  return last?.applied ? { at: last.applied, by: last.by } : null;
}
