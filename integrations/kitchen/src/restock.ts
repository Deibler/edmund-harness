/**
 * Whether running out of something means buying it again.
 *
 * The ledger cannot tell milk from something bought once for one recipe, and
 * most items in a real ledger have been bought exactly once, so no purchase
 * interval can be learned. Instead, only items bought on two or more trips
 * restock themselves (`onRunOut`); other run-outs are offered once in a
 * follow-up or dropped.
 *
 * Standing answers ("always", "never", "not this trip") live in `restock.json`
 * rather than the event log, so an undo aimed at a shopping trip cannot retract
 * a preference.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountDir } from "./accounts.ts";
import { nowIso } from "./store.ts";
import type { Category } from "./types.ts";

/** "always" restocks itself; "never" is never listed or offered. */
export type Disposition = "always" | "never";

export type Rule = {
  set: Disposition;
  at: string;
  by?: string | null;
};

/**
 * "Not this trip": off the list until the next shopping trip. Recorded as the
 * trip count at the time rather than a timestamp, because a count has no ties
 * with a receipt logged in the same second.
 */
export type Skip = {
  at: string;
  /**
   * Trips the kitchen had seen when the skip was made. Null for skips written
   * under an older trip count, which are placed on the current count by time.
   */
  shops: number | null;
};

export type Book = {
  version: 1;
  items: Record<string, Rule>;
  skips: Record<string, Skip>;
};

/**
 * Categories offered but never listed without an explicit "always": which
 * protein to buy is a fresh choice each trip, and the purchase people least
 * want made for them.
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
      // An unreadable disposition is not applied: degrade to asking, never deciding.
      if (r && (r.set === "always" || r.set === "never")) items[id] = r as Rule;
    }
    const skips: Record<string, Skip> = {};
    for (const [id, sk] of Object.entries(raw.skips ?? {})) {
      // A malformed skip is dropped (the item reappears) rather than guessed at.
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
 * Whether an item is still skipped: true until the kitchen sees one more trip
 * than it had when the skip was made. `shopsBy` places legacy skips by time.
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
 * What running out of an item means for the list.
 *
 * An explicit answer wins. Otherwise repeat purchase is the evidence a house
 * keeps something: bought on `STAPLE_TRIPS` or more trips, it is listed (or
 * offered, for proteins). Bought once, it is offered if it was cooked with and
 * dropped if it never was.
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
