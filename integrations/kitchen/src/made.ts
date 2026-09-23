/**
 * Whether a household has cooked a dish before, and when.
 *
 * A recipe is keyed by a catalog slug and a cooked meal by whatever was typed
 * into the log, so the join is reconstructed here once and shared by every
 * panel that badges, filters or ranks on "made before".
 */

import { dayKey, meals } from "./insights.ts";
import { type Recipe, loadRecipes } from "./recipes.ts";
import { slug } from "./store.ts";

export type MadeIndex = Map<string, string>;

/**
 * Every dish name the household has logged, slugged, against the latest date it
 * was cooked, including the catalog's seeded history from before the ledger.
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
 * The date this recipe was last cooked, or undefined. Three matches, narrowest
 * first: exact, singular/plural of the last word, then the dish name as a prefix
 * of a logged meal ("chicken over noodles, side salad"). The prefix only matches
 * on a slug boundary, so "beef quesadillas" never claims "beef quesadilla soup".
 */
export function lastMade(index: MadeIndex, r: Pick<Recipe, "id" | "name">): string | undefined {
  const exact = index.get(r.id) ?? index.get(slug(r.name));
  if (exact) return exact;

  // Singular or plural: only a trailing "s" on the whole slug is folded, so
  // dishes that merely share a first word never match.
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
