/**
 * Has this household actually cooked this dish before?
 *
 * Harder than it sounds, because the two sides of the question do not share a
 * key. A recipe is identified by a slug the catalog chose; a cooked meal is
 * identified by whatever somebody typed into the log that night. The join has
 * to be reconstructed, and getting it wrong is not a cosmetic bug: the site
 * uses "made before" to decide what to badge, what to filter on, and which
 * dishes it can safely offer to repeat.
 *
 * Lived here rather than inside the history panel because two panels and the
 * meal card all need the same answer, and three copies of a fuzzy match is
 * three chances to disagree with each other on the same page.
 */

import { meals } from "./insights.ts";
import { dayKey } from "./insights.ts";
import { type Recipe, loadRecipes } from "./recipes.ts";
import { slug } from "./store.ts";

export type MadeIndex = Map<string, string>;

/**
 * Every dish name this household has logged, slugged, against the most recent
 * date it was cooked. Includes the catalog's seeded history, because a dinner
 * eaten before the ledger existed was still eaten.
 */
export function madeIndex(account: string): MadeIndex {
  const out: MadeIndex = new Map();
  const put = (name: string, date: string) => {
    const k = slug(name);
    const prev = out.get(k);
    if (!prev || date > prev) out.set(k, date);
  };
  for (const s of loadRecipes().seed) put(s.meal, s.date);
  for (const m of meals(account)) put(m.name, dayKey(m.at));
  return out;
}

/**
 * The date this recipe was last cooked, or undefined.
 *
 * Three ways to match, narrowest first. The prefix rule exists because people
 * log the dish plus what they served with it ("creamy mushroom chicken over egg
 * noodles, side salad"), which is the same dinner. It only matches in that
 * direction and only on a slug boundary, so "beef quesadillas" cannot claim a
 * night somebody cooked "beef quesadilla soup".
 */
export function lastMade(index: MadeIndex, r: Pick<Recipe, "id" | "name">): string | undefined {
  const exact = index.get(r.id) ?? index.get(slug(r.name));
  if (exact) return exact;

  // Then the same dish written singular or plural. The catalog card is
  // "Buffalo Chicken Wrap" and the night it was cooked went into the ledger as
  // "Buffalo Chicken Wraps", so every exact and prefix test missed and the dish
  // read as never made here. That is not cosmetic: it took the trailing "s" to
  // put a dinner they had eaten three days earlier at the top of the page under
  // a boost meant for something untried.
  //
  // Only the LAST segment is folded, and only a trailing "s". Anything looser
  // starts matching dishes that merely share a first word, and the prefix rule
  // below already documents why "beef quesadillas" must never claim the night
  // somebody cooked "beef quesadilla soup".
  const fold = (k: string): string => k.replace(/s$/, "");
  const target = fold(slug(r.name));
  const idTarget = fold(r.id);
  let best: string | undefined;
  for (const [k, date] of index) {
    const f = fold(k);
    if ((f === target || f === idTarget) && (!best || date > best)) best = date;
  }
  if (best) return best;

  const base = slug(r.name);
  for (const [k, date] of index) {
    if (k.startsWith(`${base}-`) && (!best || date > best)) best = date;
  }
  return best;
}
