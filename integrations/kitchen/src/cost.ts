/**
 * What a recipe costs to cook, from what this household actually paid.
 *
 * Not a market price and not a lookup — the only prices here are line totals
 * off this kitchen's own receipts, so the number answers "what did this dinner
 * cost me" rather than "what does this dish cost in general".
 *
 * Two rules keep it honest:
 *
 *   A package price is not a portion price. A $15.35 pack of beef used one
 *   dinner at a time is not a $15.35 dinner. Where the purchase quantity is
 *   known the line is prorated by the share the recipe calls for; where it is
 *   not, the whole package counts, and that is flagged rather than hidden.
 *
 *   Staples are excluded, not guessed. A recipe needing "some" paprika, salt
 *   and olive oil is asking for a few cents of things nobody measures, and
 *   inventing a per-teaspoon rate for a jar would put a fabricated number in
 *   the middle of a column of real ones. They are counted and reported as
 *   uncounted instead.
 */

import type { Recipe } from "./recipes.ts";
import { droppedBatches, readLog } from "./store.ts";
import type { Item, KitchenEvent } from "./types.ts";

export type PricePoint = {
  /** What the line cost. */
  line: number;
  /** How many stocking units that line bought, when known. */
  qty: number | null;
  unit: string | null;
  store: string | null;
  at: string;
};

/**
 * Most recent price paid per item.
 *
 * The quantity comes from the priced event itself when it has one, and
 * otherwise from the nearest earlier `add` for the same item — prices
 * recovered later and written as corrections carry the money but not the
 * count, and the count is what makes proration possible.
 */
export function priceBook(account: string, events?: KitchenEvent[]): Map<string, PricePoint> {
  const evs = events ?? readLog(account);
  const dropped = droppedBatches(evs);
  const lastAddQty = new Map<string, { qty: number | null; unit: string | null }>();
  const book = new Map<string, PricePoint>();

  for (const e of evs) {
    if (e.op === "undo" || dropped.has(e.batch) || !e.item) continue;
    if (e.op === "add") {
      lastAddQty.set(e.item, { qty: e.qty ?? null, unit: e.unit ?? e.fields?.unit ?? null });
    }
    const p = e.fields?.price;
    if (typeof p !== "number") continue;
    const fallback = lastAddQty.get(e.item);
    book.set(e.item, {
      line: p,
      qty: e.qty ?? fallback?.qty ?? null,
      unit: e.unit ?? fallback?.unit ?? null,
      store: e.fields?.store ?? null,
      at: e.ts,
    });
  }
  return book;
}

export type RecipeCost = {
  /** Dollars, over the ingredients that could be costed. */
  total: number;
  /** Ingredients with a real price behind them. */
  priced: number;
  /** Ingredients that needed a price and had none. */
  unpriced: string[];
  /** Staples deliberately not costed: "some" of a jar. */
  uncounted: number;
  /**
   * True when every ingredient that could carry a cost did. A false here is
   * what turns "$8.10" into "at least $8.10" on the page.
   */
  complete: boolean;
  lines: Array<{ id: string; name: string; cost: number | null; whole: boolean }>;
};

export function recipeCost(
  recipe: Recipe,
  items: Record<string, Item>,
  book: Map<string, PricePoint>,
): RecipeCost {
  let total = 0;
  let priced = 0;
  let uncounted = 0;
  const unpriced: string[] = [];
  const lines: RecipeCost["lines"] = [];

  for (const [id, want] of recipe.needs) {
    const name = items[id]?.name ?? id.replace(/-/g, " ");
    // A leftover has no price of its own: its cost was already paid by the
    // dinner that produced it, and charging it again would double count the
    // pair. This is the whole economic point of a compound meal.
    if (id.startsWith("leftover-")) {
      lines.push({ id, name, cost: 0, whole: false });
      continue;
    }
    const it = items[id];
    // A staple is decided by what the thing IS, not by whether the recipe
    // bothered to write a number. Deciding it from a null quantity meant a
    // snack plate of meat sticks and provolone costed out at $0.00, because
    // "some provolone" and "some paprika" look identical in the catalog and
    // only one of them is pennies.
    const staple = it?.cat === "spice" || it?.cat === "condiment" || it?.qty === null;
    if (staple) {
      uncounted += 1;
      lines.push({ id, name, cost: null, whole: false });
      continue;
    }
    const p = book.get(id);
    if (!p) {
      unpriced.push(name);
      lines.push({ id, name, cost: null, whole: false });
      continue;
    }
    // An unstated quantity of a counted thing means one of them — one onion out
    // of the bag, one tortilla off the stack. That is the smallest claim the
    // catalog supports, and it beats both zero and the whole package.
    const units = want ?? 1;
    const share = p.qty && p.qty > 0 ? Math.min(1, units / p.qty) : 1;
    const cost = Math.round(p.line * share * 100) / 100;
    total += cost;
    priced += 1;
    lines.push({ id, name, cost, whole: !(p.qty && p.qty > 0) });
  }

  return {
    total: Math.round(total * 100) / 100,
    priced,
    unpriced,
    uncounted,
    complete: unpriced.length === 0,
    lines,
  };
}
