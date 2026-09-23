/**
 * What a recipe costs to cook, from what this household actually paid.
 *
 * Prices are line totals from the household's own receipts. A package price is
 * prorated by the share the recipe uses when the purchase quantity is known,
 * and counted whole (and flagged) when it is not. Staples ("some" paprika) are
 * reported as uncounted rather than given an invented per-teaspoon price.
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
 * Most recent price paid per item. The quantity comes from the priced event, or
 * from the nearest earlier `add`, since backfilled prices carry money but no
 * count.
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
  /** True when every costable ingredient had a price; false reads as "at least" on the page. */
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
    // A leftover was paid for by the dinner that produced it.
    if (id.startsWith("leftover-")) {
      lines.push({ id, name, cost: 0, whole: false });
      continue;
    }
    const it = items[id];
    // A staple is decided by what the item is, not by the recipe omitting a
    // quantity: "some provolone" is not pennies the way "some paprika" is.
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
    // An unstated quantity of a counted item means one of them.
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
