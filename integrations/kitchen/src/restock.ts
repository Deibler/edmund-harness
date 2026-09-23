/**
 * Whether running out of something means buying it again.
 *
 * The shopping list used to answer this by itself: gone from the ledger meant
 * back on the list. That is right for milk and absurd for the imitation crab
 * legs bought once for one sushi bake, and the list cannot tell them apart —
 * not because the code is naive but because the information is genuinely not
 * in the log. Both were bought once and eaten once.
 *
 * The obvious fix is a replenishment model: learn each item's purchase interval
 * and re-suggest when it is overdue. That is how grocery software does it and
 * it needs history this kitchen does not have. Measured on the real ledger the
 * day this was written: 118 of 128 items had been bought exactly once, and crab
 * legs and chicken breasts had identical profiles down to the number. A model
 * fitted to that is a coin flip wearing a lab coat, and its errors land in the
 * one place that has to stay trustworthy.
 *
 * So the list only restocks what the house has shown it keeps, by buying it on
 * more than one trip (`onRunOut`). Anything else that runs out is offered once,
 * in the follow-up after a meal, or dropped when it was never cooked with.
 *
 * Kept out of the event log deliberately, on the same reasoning as `list.ts`:
 * the log records what happened to food, and "we always keep this" is a
 * standing preference rather than an event. Folding it in would mean a
 * disposition could be retracted by an undo aimed at a shopping trip.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountDir } from "./accounts.ts";
import { nowIso } from "./store.ts";
import type { Category } from "./types.ts";

/** "always" restocks itself. "never" stops asking. Absent means ask once. */
export type Disposition = "always" | "never";

export type Rule = {
  set: Disposition;
  at: string;
  by?: string | null;
};

/**
 * "Not this trip."
 *
 * The third answer, and the one a permanent disposition cannot express: you are
 * not buying broth today but you have not stopped keeping broth. What ends it
 * is the trip itself, so what is recorded is HOW MANY trips this kitchen had
 * seen when it was said, and the skip expires as soon as it has seen one more.
 *
 * Counting rather than timestamping is deliberate. The first version compared
 * the skip's time against the last purchase, and ledger timestamps are
 * second-resolution: a skip tapped in the same second a receipt landed was
 * indistinguishable from one tapped just before it, and no tie-break was
 * correct for both cases. A trip counter has no ties.
 */
export type Skip = {
  at: string;
  /**
   * Shopping trips this kitchen had seen when the skip was made. Null for a skip
   * written before trips were counted by shop rather than by write, whose old
   * number counted shelf photos and leftovers too and means nothing against
   * the new count. Those are placed on the new count by their time instead.
   */
  shops: number | null;
};

export type Book = {
  version: 1;
  items: Record<string, Rule>;
  skips: Record<string, Skip>;
};

/**
 * Categories that never auto-add, whatever the item's own history says.
 *
 * Which protein to buy this week is a fresh decision every trip, not a standing
 * order, and it is the purchase people most want to make themselves — the
 * consumer research on delegated reordering puts roughly two thirds of shoppers
 * unwilling to hand even staples to software, and meat is the least delegated
 * of the lot. So these are suggested and never listed unless somebody has
 * explicitly said "always" for that exact item.
 */
export const ASK_CATEGORIES: readonly Category[] = ["meat", "seafood"];

export function restockPath(account: string): string {
  return join(accountDir(), account, "restock.json");
}

export function readBook(account: string): Book {
  const p = restockPath(account);
  const empty: Book = { version: 1, items: {}, skips: {} };
  if (!existsSync(p)) return empty;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Book>;
    const items: Record<string, Rule> = {};
    for (const [id, r] of Object.entries(raw.items ?? {})) {
      // A disposition that cannot be read is a disposition that is not applied,
      // which puts the item back in the tray rather than onto the list. Same
      // call as everywhere else here: degrade to asking, never to deciding.
      if (r && (r.set === "always" || r.set === "never")) items[id] = r as Rule;
    }
    const skips: Record<string, Skip> = {};
    for (const [id, sk] of Object.entries(raw.skips ?? {})) {
      // Anything of another shape is dropped rather than guessed at. Dropping a
      // skip puts the item back on the list, which somebody will see and can
      // correct in one tap; inventing a trip count would hide it silently.
      if (!sk || typeof sk !== "object") continue;
      const { at, shops } = sk as Partial<Skip>;
      if (typeof shops === "number") skips[id] = { at: String(at ?? ""), shops };
      else if (typeof at === "string" && Number.isFinite(Date.parse(at)))
        skips[id] = { at, shops: null };
    }
    return { version: 1, items, skips };
  } catch {
    return empty;
  }
}

function write(account: string, b: Book): void {
  const p = restockPath(account);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(b, null, 2));
  renameSync(tmp, p);
}

export function setDisposition(
  account: string,
  ids: string[],
  set: Disposition,
  by?: string | null,
): number {
  const b = readBook(account);
  let n = 0;
  for (const id of ids) {
    if (!id) continue;
    b.items[id] = { set, at: nowIso(), by: by ?? null };
    n++;
  }
  if (n) write(account, b);
  return n;
}

/** Forget an answer, so the item is asked about again next time it runs out. */
export function clearDisposition(account: string, ids: string[]): number {
  const b = readBook(account);
  let n = 0;
  for (const id of ids)
    if (b.items[id]) {
      delete b.items[id];
      n++;
    }
  if (n) write(account, b);
  return n;
}

export function dispositionOf(book: Book, id: string): Disposition | null {
  return book.items[id]?.set ?? null;
}

export function skip(account: string, ids: string[], shops: number): number {
  const b = readBook(account);
  let n = 0;
  for (const id of ids)
    if (id) {
      b.skips[id] = { at: nowIso(), shops };
      n++;
    }
  if (n) write(account, b);
  return n;
}

export function unskip(account: string, ids: string[]): number {
  const b = readBook(account);
  let n = 0;
  for (const id of ids)
    if (b.skips[id]) {
      delete b.skips[id];
      n++;
    }
  if (n) write(account, b);
  return n;
}

/**
 * Is this still being skipped?
 *
 * Live until the kitchen has seen a trip it did not see when the skip was made.
 * "Not this trip" therefore survives exactly one trip and no more, whatever the
 * clock did in between.
 *
 * `shopsBy` places a skip from before the count changed meaning. It goes by
 * time, with the tie the counter exists to avoid, but only for skips already
 * on disk, and the cost of a wrong tie there is one item back on one list.
 */
export function skipped(
  book: Book,
  id: string,
  shops: number,
  shopsBy: (iso: string) => number,
): boolean {
  const s = book.skips[id];
  if (!s) return false;
  return shops <= (s.shops ?? shopsBy(s.at));
}

/** Trips an item must have been bought on before it counts as something this house keeps. */
export const STAPLE_TRIPS = 2;

/** What happens when an item runs out. */
export type RunOut =
  /** Straight onto the list: the house keeps this. */
  | "list"
  /** Offered in the next follow-up ("running low on X, add it?"). */
  | "offer"
  /** Dropped quietly: bought once and never cooked with. */
  | "drop";

/**
 * Decide what running out of an item means for the list.
 *
 * Repeat purchase is the evidence that a house keeps something. An item bought
 * on two or more separate trips goes back on the list by itself; one bought
 * once does not, however many times it was eaten, because once is not a habit.
 * Proteins are offered rather than listed even when they are kept: which meat
 * to buy is a fresh choice every week. An explicit answer beats all of this.
 *
 * Something bought once and never cooked with is dropped. It was an experiment
 * or a one-off, and asking about it would be noise.
 */
export function onRunOut(
  book: Book,
  id: string,
  cat: Category | null,
  seen: { trips: number; mealUses: number },
): RunOut {
  const own = dispositionOf(book, id);
  if (own === "always") return "list";
  if (own === "never") return "drop";
  const kept = seen.trips >= STAPLE_TRIPS;
  if (kept && !ASK_CATEGORIES.includes(cat as Category)) return "list";
  return kept || seen.mealUses > 0 ? "offer" : "drop";
}
