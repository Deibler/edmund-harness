/**
 * Purchase and use history, folded from the ledger.
 *
 * Everything the kitchen infers about habits starts here: how often something
 * is bought, whether it is actually cooked with, and when it was last seen.
 */

import { droppedBatches } from "./store.ts";
import type { KitchenEvent } from "./types.ts";

/**
 * The shopping trip an event is evidence of, or null when it is not one.
 *
 * Only three shapes count as a shop: a receipt (`receipt:giant-2026-01-10`), a
 * shop logged without one (`trip:aldi-2026-01-12`), and lines ticked off the
 * list in the store (`shopped`). A shelf photo, a leftover put away or a
 * correction adds food without anybody going to a store.
 *
 * Keyed by the receipt rather than the write, because one receipt can arrive
 * more than once (a re-import, or its printed total logged later).
 */
export function tripKey(e: KitchenEvent): string | null {
  if (e.op === "trip") return e.src ? sameTrip(e.src) : e.batch;
  if (e.op !== "add") return null;
  if (e.src === "shopped") return e.batch;
  return e.src && /^(receipt|trip):/.test(e.src) ? sameTrip(e.src) : null;
}

/**
 * One receipt, however it was re-imported. `receipt:costco-2026-09-20-corrected`
 * is the same shop as `receipt:costco-2026-09-20`, and counting it twice would
 * make everything on it look like a repeat purchase.
 */
function sameTrip(src: string): string {
  return /^((?:receipt|trip):.*?\d{4}-\d{2}-\d{2})/.exec(src)?.[1] ?? src;
}

/** A `use` that came from cooking a meal, as opposed to a correction or a cleanup. */
const isMealUse = (e: KitchenEvent): boolean => e.op === "use" && e.src === "cooked";

/** Stamped on writes made because nobody answered a follow-up. */
export const ASSUMED_SRC = "assumed";

/** Stamped on writes the model made by reasoning over evidence rather than being told. */
export const REASONED_SRC = "reasoned";

/**
 * Writes that are not somebody looking at the food: arithmetic, inference and
 * bookkeeping. Everything else that adds or corrects an item (a photo, a shelf
 * check, "Sam says we have eggs") is an observation.
 */
const NOT_OBSERVED = /^(auto-cleanup|assumed|reasoned|backfill|cooked|plan)/;

const isObservation = (e: KitchenEvent): boolean =>
  (e.op === "add" || e.op === "set") && tripKey(e) === null && !NOT_OBSERVED.test(e.src ?? "");

export type ItemHistory = {
  /** Distinct shopping trips this item was bought on. */
  trips: number;
  /** ISO of the most recent purchase, if it was ever bought on a trip. */
  lastBought: string | null;
  /** Meals cooked with it, ever. */
  mealUses: number;
  /** Meals cooked with it since the last purchase, newest last. */
  mealsSinceBought: Array<{ meal: string; at: string }>;
  /** Meals that were planned with it since the last purchase and never confirmed. */
  plannedSinceBought: Array<{ meal: string; at: string; status: "open" | "dropped" }>;
  /** ISO of the last time somebody looked at it: a photo, a shelf check, a correction. */
  lastSeen: string | null;
};

export type History = {
  items: Map<string, ItemHistory>;
  /** Trips this kitchen has seen in total. */
  trips: number;
  /** How many trips had started by a moment in the past. */
  shopsBy: (iso: string) => number;
  /** ISO of the most recent meal confirmed as cooked, if any. */
  lastMeal: string | null;
};

const blank = (): ItemHistory => ({
  trips: 0,
  lastBought: null,
  mealUses: 0,
  mealsSinceBought: [],
  plannedSinceBought: [],
  lastSeen: null,
});

export function history(events: KitchenEvent[]): History {
  const dropped = droppedBatches(events);
  const items = new Map<string, ItemHistory>();
  const get = (id: string) => items.get(id) ?? items.set(id, blank()).get(id)!;
  const tripsPer = new Map<string, Set<string>>();
  const tripStarts = new Map<string, number>();
  const planStatus = new Map<string, "open" | "done" | "dropped">();
  let lastMeal: string | null = null;

  // An undone "we made it" or "we didn't" leaves the plan open, as in the fold.
  for (const e of events) {
    if (dropped.has(e.batch)) continue;
    if (e.op === "plan_done" && e.plan_id) planStatus.set(e.plan_id, "done");
    if (e.op === "plan_void" && e.plan_id) planStatus.set(e.plan_id, "dropped");
  }

  for (const e of events) {
    if (e.op === "undo" || dropped.has(e.batch)) continue;
    const trip = tripKey(e);
    if (trip !== null && !tripStarts.has(trip)) tripStarts.set(trip, Date.parse(e.ts));
    if (e.op === "plan_done") lastMeal = e.ts;

    if (e.op === "plan" && e.plan) {
      const status = planStatus.get(e.plan.id) ?? "open";
      if (status === "done") continue; // its uses are recorded as meal uses
      for (const l of e.plan.lines) {
        get(l.item).plannedSinceBought.push({ meal: e.plan.meal, at: e.ts, status });
      }
      continue;
    }
    if (!e.item) continue;
    const h = get(e.item);

    if (trip !== null) {
      const seen = tripsPer.get(e.item) ?? new Set<string>();
      seen.add(trip);
      tripsPer.set(e.item, seen);
      h.trips = seen.size;
      h.lastBought = e.ts;
      h.mealsSinceBought = [];
      h.plannedSinceBought = [];
    }
    if (isMealUse(e)) {
      h.mealUses++;
      h.mealsSinceBought.push({ meal: e.why ?? "a meal", at: e.ts });
    }
    if (isObservation(e)) h.lastSeen = e.ts;
  }

  const starts = [...tripStarts.values()];
  return {
    items,
    trips: tripStarts.size,
    shopsBy: (iso) => {
      const t = Date.parse(iso);
      return starts.filter((s) => s <= t).length;
    },
    lastMeal,
  };
}

/**
 * When each item was last bought, and how many trips there have been.
 *
 * The narrow view the shopping list needs; see `history` for the full one.
 */
export function purchaseHistory(events: KitchenEvent[]) {
  const h = history(events);
  const lastBought = new Map<string, string>();
  for (const [id, x] of h.items) if (x.lastBought) lastBought.set(id, x.lastBought);
  return { lastBought, trips: h.trips, shopsBy: h.shopsBy };
}
