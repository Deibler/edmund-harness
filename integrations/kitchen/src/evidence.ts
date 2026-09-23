/**
 * What the kitchen can say about each item beyond "the ledger lists it".
 *
 * Households record groceries and little else. Nobody logs finishing the
 * onions, freezing the chicken or throwing out the grapes, so a ledger that
 * believes everything it was told drifts away from the kitchen within a week.
 * This module gathers the evidence a person would use (when it was bought, what
 * was cooked with it since, when anyone last looked, how long that food keeps
 * where it is stored) and turns it into an estimate with plain reasons.
 *
 * The estimate is a starting point for judgement, not a verdict. The morning
 * review hands the uncertain items to the model with this evidence, and only
 * the model or a person decides that something is gone.
 */

import { type ShelfLife, shelfLife } from "./foods.ts";
import { type ItemHistory, history } from "./history.ts";
import { daysLeft, fold, live, readLog } from "./store.ts";
import type { Item, KitchenEvent } from "./types.ts";

const DAY = 86_400_000;

export type Estimate =
  /** Seen, bought or cooked with recently. No reason to doubt it. */
  | "fresh"
  /** Probably still there, within its normal life. */
  | "likely"
  /** Could go either way: worth a question, not worth a claim. */
  | "unsure"
  /** Past any reasonable life, or used up by the meals cooked since. */
  | "doubtful";

export type Evidence = {
  item: Item;
  estimate: Estimate;
  /** Plain-English facts behind the estimate, most telling first. */
  reasons: string[];
  /** Days since the item last entered the house or was confirmed present. */
  age: number;
  shelf: ShelfLife | null;
  history: ItemHistory | null;
};

const days = (from: string | null | undefined, now: number): number | null =>
  from ? Math.max(0, Math.floor((now - Date.parse(from)) / DAY)) : null;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Meals cooked with a level-tracked item before it is plausibly used up. A jar
 * of paprika survives a dozen dinners; a can of tomato paste survives two.
 */
const USES_TO_EMPTY: Partial<Record<Item["cat"], number>> = {
  spice: 15,
  condiment: 8,
  pantry: 4,
};
const usesToEmpty = (it: Item): number => USES_TO_EMPTY[it.cat] ?? 3;

export function assess(item: Item, h: ItemHistory | null, now = Date.now()): Evidence {
  const reasons: string[] = [];
  const shelf = shelfLife(item);
  const bought = days(h?.lastBought, now);
  const seen = days(h?.lastSeen, now);
  const touched = days(item.updated, now) ?? 0;
  // The freshest proof the item was in the house: a purchase, a look, or any write.
  const age = Math.min(
    bought ?? Number.POSITIVE_INFINITY,
    seen ?? Number.POSITIVE_INFINITY,
    touched,
  );

  if (bought !== null)
    reasons.push(`bought ${bought === 0 ? "today" : `${plural(bought, "day")} ago`}`);
  if (seen !== null && (bought === null || seen < bought))
    reasons.push(`last seen ${plural(seen, "day")} ago`);

  const meals = h?.mealsSinceBought ?? [];
  const planned = (h?.plannedSinceBought ?? []).filter((p) => p.status === "open");
  if (meals.length) {
    reasons.push(
      `cooked into ${plural(meals.length, "meal")} since (${meals
        .slice(-3)
        .map((m) => m.meal)
        .join(", ")})`,
    );
  }
  if (planned.length) {
    reasons.push(
      `in ${plural(planned.length, "suggested meal")} nobody confirmed (${planned
        .slice(-3)
        .map((p) => p.meal)
        .join(", ")})`,
    );
  }

  const printed = daysLeft(item, new Date(now));
  if (printed !== null && printed < 0) reasons.push(`${plural(-printed, "day")} past its date`);

  const est = ((): Estimate => {
    // Used up by cooking, whatever the calendar says. A counted item already
    // has its uses subtracted; one tracked by level only has the meal count.
    const usedUp =
      item.qty === null ? meals.length >= usesToEmpty(item) : item.qty <= 0.25 && meals.length > 0;
    if (usedUp) {
      reasons.unshift("probably used up by the meals cooked since it was bought");
      return (bought ?? age) > 7 ? "doubtful" : "unsure";
    }
    if (age <= 2) return "fresh";
    if (!shelf) {
      // Pantry, frozen, spices: the clock says nothing. Only use does.
      return meals.length >= usesToEmpty(item) / 2 ? "unsure" : "likely";
    }
    const { low, high } = shelf.life;
    if (age <= low) return planned.length ? "unsure" : "likely";
    if (shelf.mayBeFrozen) {
      reasons.push(`past fridge life (${low}-${high} days), so frozen, cooked or tossed`);
      return "unsure";
    }
    if (age <= high) {
      reasons.push(`within its usual ${low}-${high} days, near the end`);
      return "unsure";
    }
    reasons.push(`past its usual ${low}-${high} days`);
    return age > high * 1.5 ? "doubtful" : "unsure";
  })();

  return { item, estimate: est, reasons, age, shelf, history: h };
}

/** Evidence for every item the ledger still lists, most doubtful first. */
export function evidence(
  account: string,
  opts: { now?: number; events?: KitchenEvent[] } = {},
): Evidence[] {
  const now = opts.now ?? Date.now();
  const events = opts.events ?? readLog(account);
  const h = history(events);
  const rank: Record<Estimate, number> = { doubtful: 0, unsure: 1, likely: 2, fresh: 3 };
  return live(account, fold(account, events))
    .filter((it) => !it.id.startsWith("leftover-"))
    .map((it) => assess(it, h.items.get(it.id) ?? null, now))
    .sort((a, b) => rank[a.estimate] - rank[b.estimate] || b.age - a.age);
}

/** One line per item, for a brief or a status answer. */
export function describeEvidence(e: Evidence): string {
  return `${e.item.name} [${e.item.id}, ${e.item.loc}]: ${e.reasons.join("; ") || "no history"}`;
}
