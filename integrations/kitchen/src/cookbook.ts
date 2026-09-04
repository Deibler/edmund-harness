/**
 * Recipes that have actually been written out, and the variants that hang off
 * them.
 *
 * The catalog in `recipes.ts` is a standing description of a dish — a name, a
 * time, and the ledger slugs it consumes. That is enough to answer "can I cook
 * this tonight", which is all the catalog was ever for. It is nowhere near
 * enough to cook from: no amounts, no order, no technique.
 *
 * Writing that long form costs a model call, so it is written ONCE and kept.
 * The second time somebody makes chicken and rice they get the same page
 * instantly, which is the whole point of this file. A recipe is not an event,
 * so it does not go in the ledger; it is a document, and it lives as one.
 *
 * Variants are the other half. When a meal cannot be made because the house is
 * out of something, the useful move is not "sorry" — it is "here is that meal
 * built around what you do have". A variant records its parent, and the two
 * group in the UI as one dish with several versions rather than two unrelated
 * dinners cluttering the catalog.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";
import { nowIso, slug } from "./store.ts";
import { safeId } from "./util.ts";

export type Ingredient = {
  /** Display line, e.g. "Yellow onion". */
  name: string;
  /** Display amount, e.g. "1 medium, diced". Free text on purpose — a recipe
   *  amount is prose ("a splash", "2 cloves"), not a number with a unit. */
  amount: string;
  /** Ledger slug when this maps to tracked stock, so a recipe page can show
   *  live availability per line instead of just listing words. */
  item?: string | null;
  note?: string | null;
};

export type Step = {
  n: number;
  title: string;
  body: string;
  /** Minutes this step takes, when it is a timed one. Drives the page timer. */
  minutes?: number | null;
  /**
   * Two-cook assignment, retired 2026-08-16.
   *
   * Steps used to carry a cook number and handoff notes, and the page could
   * filter to one person's half. It was removed because it made every step ask
   * "is this mine" before it asked "what do I do", which is a question about the
   * interface rather than about the food. Recipes written while it existed still
   * carry the fields; nothing reads them.
   */
  /**
   * What this step actually puts in the pan, with the amount for THIS step.
   *
   * `ingredient` matches an entry in the recipe's `ingredients` by name, so the
   * page resolves live stock and the shopping amount from one place and the two
   * can never disagree. `amount` is the portion used here ("half the onion"),
   * which is the number you need while cooking; the top-of-page figure is the
   * one you need while shopping, and conflating them is why a recipe makes you
   * scroll up mid-step.
   */
  uses?: Array<{ ingredient: string; amount?: string | null }>;
  /**
   * The step broken into single actions, in order.
   *
   * A step used to be one paragraph carrying every detail, which is correct and
   * unreadable: standing at a stove you need to find your place in it after
   * every glance at the pan. Same detail, one action per line, so a glance
   * lands somewhere. `body` becomes the one-line why, not the instruction.
   */
  parts?: string[];
  /**
   * How to tell the step is finished, in what you can see, hear or smell.
   *
   * Pulled out of the prose deliberately. It is the single most looked-at
   * sentence in any step and it was buried in the middle of a paragraph.
   */
  watch?: string | null;
  /**
   * Technique ids from `techniques.ts` this step is demonstrating.
   *
   * Optional because the page infers them from the step's own words; this is
   * for the cases where the writer knows better than a regex.
   */
  techniques?: string[];
};

export type BuiltRecipe = {
  id: string;
  /** Parent recipe id when this is a variant of another dish, else null. */
  base: string | null;
  name: string;
  desc: string;
  minutes: number;
  serves: number;
  /** Ledger slugs consumed, same shape as the catalog, for cookability. */
  needs: Array<[string, number | null]>;
  ingredients: Ingredient[];
  steps: Step[];
  /** Why this variant exists, e.g. "no cream in the house, built on milk". */
  variantReason?: string | null;
  built: string;
  builtBy?: string | null;
  cat: string;
};

function dir(account: string): string {
  return join(accountDir(), account, "cookbook");
}

/**
 * Where a recipe lives, and the one place an id becomes a path.
 *
 * Validated here rather than at each caller because there are seven of them and
 * the ids reach this from three directions: a model writing a recipe, a page id
 * in a URL, and a `recipe` field on a callback that anyone with the site link
 * can post. Any of those carrying "../.." would read or write outside the
 * cookbook, so the check sits at the chokepoint where it cannot be skipped.
 */
export function recipePath(account: string, id: string): string {
  if (!safeId(id)) {
    throw new Error(`"${id}" is not a recipe id: lowercase letters, digits and dashes only.`);
  }
  return join(dir(account), `${id}.json`);
}

// The two READ paths answer "no" for a malformed id rather than throwing: a
// lookup is a question, and the honest answer to "is ../../etc/passwd a recipe
// in this cookbook" is no. Writing with one is a different matter and keeps the
// throw, because nothing legitimate ever asks for it.
export function hasRecipe(account: string, id: string): boolean {
  return safeId(id) && existsSync(recipePath(account, id));
}

export function getRecipe(account: string, id: string): BuiltRecipe | null {
  if (!safeId(id)) return null;
  const p = recipePath(account, id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BuiltRecipe;
  } catch {
    // One unreadable recipe costs that recipe, not the cookbook.
    return null;
  }
}

export function loadCookbook(account: string): BuiltRecipe[] {
  const d = dir(account);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(d, f), "utf8")) as BuiltRecipe;
      } catch {
        return null;
      }
    })
    .filter((r): r is BuiltRecipe => r !== null);
}

export function saveRecipe(
  account: string,
  r: Omit<BuiltRecipe, "built"> & { built?: string },
): BuiltRecipe {
  const d = dir(account);
  mkdirSync(d, { recursive: true });
  const full: BuiltRecipe = { ...r, built: r.built ?? nowIso() };
  writeFileSync(recipePath(account, full.id), JSON.stringify(full, null, 2));
  return full;
}

/**
 * A free id for a variant of `baseId`, e.g. `chicken-rice--no-cream`.
 *
 * The double dash is load-bearing: it makes the parent recoverable from the id
 * alone, so a variant whose file predates the `base` field still groups right.
 */
export function variantId(baseId: string, label: string): string {
  return `${baseId}--${slug(label)}`;
}

export function baseIdOf(r: Pick<BuiltRecipe, "id" | "base">): string {
  return r.base ?? (r.id.includes("--") ? r.id.split("--")[0]! : r.id);
}

export type RecipeGroup = {
  baseId: string;
  /** The original dish if it has been built, else the earliest variant. */
  primary: BuiltRecipe;
  variants: BuiltRecipe[];
};

/** Group a cookbook into one entry per dish, variants nested underneath. */
export function groupRecipes(recipes: BuiltRecipe[]): RecipeGroup[] {
  const byBase = new Map<string, BuiltRecipe[]>();
  for (const r of recipes) {
    const b = baseIdOf(r);
    (byBase.get(b) ?? byBase.set(b, []).get(b)!).push(r);
  }
  const groups: RecipeGroup[] = [];
  for (const [baseId, rs] of byBase) {
    const sorted = [...rs].sort((a, b) => a.built.localeCompare(b.built));
    const primary = sorted.find((r) => r.id === baseId) ?? sorted[0]!;
    groups.push({ baseId, primary, variants: sorted.filter((r) => r.id !== primary.id) });
  }
  return groups.sort((a, b) => b.primary.built.localeCompare(a.primary.built));
}
