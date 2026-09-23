/**
 * Recipes that have been written out in full, and their variants.
 *
 * The catalog (`recipes.ts`) knows enough to answer "can we cook this"; a
 * written recipe has amounts, order and technique. Writing one costs a model
 * call, so it is written once and kept as a document per dish. A variant (the
 * dish rebuilt around what the house has) records its parent, and the site
 * groups them as one dish with several versions.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";
import { nowIso, slug } from "./store.ts";
import { safeId } from "./util.ts";

export type Ingredient = {
  /** Display line, e.g. "Yellow onion". */
  name: string;
  /** Display amount, e.g. "1 medium, diced". Free text: recipe amounts are prose. */
  amount: string;
  /** Ledger slug when this maps to tracked stock, for live availability per line. */
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
   * What this step puts in the pan and how much of it, by `ingredients` name.
   * The per-step amount is what the cook needs mid-step; the ingredient list
   * holds the shopping amount.
   */
  uses?: Array<{ ingredient: string; amount?: string | null }>;
  /** The step as single actions, in order. `body` is then the one-line why. */
  parts?: string[];
  /** How to tell the step is finished, in what you can see, hear or smell. */
  watch?: string | null;
  /**
   * Technique ids from `techniques.ts` the step demonstrates. When absent, the
   * page infers them from the step's words.
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
 * The one place a recipe id becomes a path. Ids arrive from the model, from
 * URLs and from public site callbacks, so a traversal is refused here rather
 * than at each caller.
 */
export function recipePath(account: string, id: string): string {
  if (!safeId(id)) {
    throw new Error(`"${id}" is not a recipe id: lowercase letters, digits and dashes only.`);
  }
  return join(dir(account), `${id}.json`);
}

/** A written recipe, or null. A malformed id is "not a recipe" here; writing with one throws. */
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
 * The id for a variant of `baseId`, e.g. `chicken-rice--no-cream`. The double
 * dash keeps the parent recoverable from the id alone (see `baseIdOf`).
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
