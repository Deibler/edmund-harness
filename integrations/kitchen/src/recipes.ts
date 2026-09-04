/**
 * The meal catalog, and what it can be cooked into tonight.
 *
 * The catalog is a flat JSON file rather than a table in the ledger, because a
 * recipe is not an event — it is a standing description of a dish, and folding
 * it out of a log would mean re-deriving something nobody ever changes.
 *
 * `needs` uses canonical ledger slugs, which is what makes cookability a real
 * check rather than a fuzzy name match. If a recipe names something the ledger
 * has never heard of, that shows up as an unknown ingredient instead of being
 * silently treated as available — the same "never claim food that isn't there"
 * rule the rest of this integration runs on.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";
import type { Item } from "./types.ts";

export type Recipe = {
  id: string;
  name: string;
  desc: string;
  minutes: number;
  /** [ledger slug, quantity]. A null quantity means "some" — presence is enough. */
  needs: Array<[string, number | null]>;
  cat: string;
  /**
   * Recipe ids whose LEFTOVERS this dish is built from.
   *
   * A compound meal is the second life of something already cooked: tonight's
   * rice becoming tomorrow's fried rice, the roast becoming sandwiches.
   *
   * It is deliberately NOT gated on the leftover already existing. Gating it
   * that way was the original design and it was backwards in practice: it could
   * only ever suggest a dish once the food was already sitting in the fridge,
   * by which time the useful decision — cook the bigger batch tonight — was
   * hours gone, and most of what it suggested was going stale while it waited
   * to be suggested. The unit that matters is the PAIR, planned forward: cook
   * this tonight and it becomes that tomorrow. See `compoundPairs`.
   */
  from?: string[];
  /**
   * Leftover slugs this dish is expected to produce, and roughly how much.
   *
   * This is what makes the pair plannable a day early. A child's `from` says
   * which parents can feed it; the parent's `yields` says what actually lands
   * in the fridge, which is the thing the child needs. Both halves are needed
   * because the relationship is many-to-many: three different rice dinners all
   * yield `leftover-rice`.
   */
  yields?: Array<[string, number | null]>;
  /**
   * 1-5, how healthy the dish is, written by whoever curated it.
   *
   * Deliberately hand-set rather than computed from macros: the macro table is
   * category-level for most items, so a derived score would carry a precision
   * it has not earned. A stated opinion labelled as one beats a number that
   * looks measured and isn't.
   */
  health?: number;
  /**
   * How much of your day this asks for, which is a different question from how
   * many minutes it takes.
   *
   * Minutes measure the clock; effort measures whether you can start it after
   * work. A forty-minute braise you walk away from is a weeknight; a
   * forty-minute risotto you stand over is not. "project" is the Sunday dinner,
   * "allday" is the thing that starts in the morning and becomes the day's plan.
   */
  effort?: Effort;
  /** Where it actually cooks. `crockpot` is the one that changes the day. */
  method?: Method;
  /** How many people one batch feeds, as written. */
  serves?: number;
  /**
   * Days this keeps feeding you at the written batch size. 1 means it is dinner
   * and then it is gone; 4 means a Sunday afternoon buys most of the week.
   *
   * This is the meal-prep axis and it is deliberately NOT `yields`: yields is
   * about a dish becoming a DIFFERENT dish, this is about eating the same one
   * again, and conflating them is how "leftovers" became a category nobody
   * wanted to see on a card.
   */
  feeds_days?: number;
  /**
   * Months (1-12) this belongs to. Empty or absent means any time of year.
   *
   * Stated per dish rather than derived from ingredients: strawberries are a
   * June crop and a year-round supermarket item, so an ingredient calendar
   * would be confidently wrong about what is worth cooking in February.
   */
  season?: number[];
  /**
   * Occasion tags. The mood engine reads these:
   * weekend, sunday, gameday, holiday, cookout, cozy, hotday, party.
   */
  occasions?: string[];
  /** 1 cheap, 2 ordinary, 3 blowout. Ranked against the household's mode. */
  spend?: 1 | 2 | 3;
  /** e.g. "thai", "sicilian". Used to measure distance from the usual. */
  cuisine?: string;
};

export type Effort = "quick" | "weeknight" | "project" | "allday";
export type Method =
  | "stovetop"
  | "oven"
  | "sheetpan"
  | "crockpot"
  | "instantpot"
  | "grill"
  | "airfryer"
  | "nocook";

/**
 * The effort a dish states, or the one its clock implies.
 *
 * A catalog written before this field existed still has to sort correctly, and
 * minutes are the only evidence those entries carry. Inferring is honest here
 * in a way it would not be for season or cost, because the mapping is a claim
 * about the clock and nothing else.
 */
export function effortOf(r: Recipe): Effort {
  if (r.effort) return r.effort;
  if (r.minutes >= 240) return "allday";
  if (r.minutes >= 75) return "project";
  return r.minutes <= 25 ? "quick" : "weeknight";
}

export const EFFORT_LABEL: Record<Effort, string> = {
  quick: "Quick",
  weeknight: "Weeknight",
  project: "Project",
  allday: "All day",
};

export const METHOD_LABEL: Record<Method, string> = {
  stovetop: "Stovetop",
  oven: "Oven",
  sheetpan: "Sheet pan",
  crockpot: "Slow cooker",
  instantpot: "Pressure cooker",
  grill: "Grill",
  airfryer: "Air fryer",
  nocook: "No cook",
};

/** True when this dish is claimed for the given month (1-12). */
export function inSeason(r: Recipe, month: number): boolean {
  return !!r.season?.length && r.season.includes(month);
}

/** Dishes that answer "what are we eating", as opposed to sides and sweets. */
export const MEAL_CATS = new Set(["dinner", "lunch", "compound"]);

/**
 * True when one batch is meant to be eaten for days rather than tonight.
 *
 * Gated on being a real meal, which is not pedantry: a tray of cookies keeps
 * for four days, so a plain `feeds_days >= 3` test put chocolate chip cookies
 * at the top of a page whose whole claim was that it knew what kind of day it
 * was. Keeping for days and feeding you for days are different sentences.
 */
export function feedsAllWeek(r: Recipe): boolean {
  return MEAL_CATS.has(r.cat) && ((r.feeds_days ?? 1) >= 3 || r.method === "crockpot");
}

export type CookedSeed = { date: string; meal: string };

/**
 * Where the catalog lives. The Python skill owns the file today, so this reads
 * it in place rather than keeping a second copy that would drift the first time
 * anyone added a dinner on the other side.
 */
/**
 * The shared meal catalog, which lives with the skill rather than the data.
 *
 * Resolved from this file's own location, not from `$HOME`. A launchd job runs
 * with a trimmed environment, and the old form quietly resolved to
 * `/skills/kitchen/recipes.json`, which does not exist — so the catalog silently
 * read as empty and every household looked like it had no meal ideas.
 */
export function catalogPath(): string {
  return (
    process.env.KITCHEN_RECIPES ??
    join(import.meta.dir, "..", "..", "..", "skills", "kitchen", "recipes.json")
  );
}

/**
 * A household's own recipes, layered over the shared catalog.
 *
 * The shared catalog is a fixed set of dishes somebody wrote once, which is
 * exactly the thing that goes stale: after a fortnight it is still proposing
 * the same twelve dinners off the same opening week of shopping, and the site
 * starts feeling like an archive. The overlay is where the daily pass writes
 * ideas built from what is in THIS kitchen this week, and where it retires them
 * when the stock they were built on is gone.
 *
 * Kept per tenant and out of the shared file on purpose: a dish generated from
 * Alex and Sam's fridge is not a dish Jordan can cook, and merging them
 * would put food in his catalog that he does not own.
 */
export function overlayPath(account: string): string {
  return join(accountDir(), account, "recipes.json");
}

export function loadRecipes(account?: string): { recipes: Recipe[]; seed: CookedSeed[] } {
  const p = catalogPath();
  let recipes: Recipe[] = [];
  let seed: CookedSeed[] = [];
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      recipes = (raw.recipes as Recipe[]) ?? [];
      seed = (raw.history_seed as CookedSeed[]) ?? [];
    } catch {
      // A malformed catalog costs the meal pages, not the whole site. Same call
      // as the torn-ledger-line one in store.ts: degrade to less, never nothing.
    }
  }
  if (!account) return { recipes, seed };

  const op = overlayPath(account);
  if (!existsSync(op)) return { recipes, seed };
  try {
    const raw = JSON.parse(readFileSync(op, "utf8")) as { recipes?: Recipe[] };
    const own = raw.recipes ?? [];
    // Household wins on a collision: an idea generated from this fridge is more
    // current than the shared entry it shadows.
    const mine = new Set(own.map((r) => r.id));
    return { recipes: [...recipes.filter((r) => !mine.has(r.id)), ...own], seed };
  } catch {
    return { recipes, seed };
  }
}

export type Need = {
  id: string;
  name: string;
  want: number | null;
  /**
   * "have" | "short" | "out".
   *
   * "short" is ADVISORY and deliberately never counts as missing. See
   * `cookable` for why: it is a comparison between two numbers that are not in
   * the same unit and there is no third fact that could reconcile them.
   */
  state: "have" | "short" | "out";
};

export type Cookable = {
  recipe: Recipe;
  needs: Need[];
  missing: Need[];
  /** True when every ingredient is in the house in sufficient quantity. */
  ready: boolean;
};

/**
 * Score every recipe against live stock.
 *
 * A level-tracked staple (qty null — salt, oil, spices) counts as available if
 * it is not marked out, because nobody knows how many teaspoons are in the jar
 * and inventing a number here would be the same lie the ledger refuses to tell.
 * Only a counted item can be "short".
 *
 * PRESENCE DECIDES, QUANTITY ADVISES. A recipe's want is a bare number with no
 * unit — "4" for chicken thighs — while the shelf holds "1 pkg", and comparing
 * those two produced a shortage every time somebody stocked a package of
 * anything a recipe counted in pieces. It survived a restock, so buying more
 * never cleared it. On the real ledger this marked chicken thighs bought the
 * previous day, a bag of limes and a cluster of tomatoes as things to go and
 * buy, and told the home page three dinners were uncookable that were sitting
 * in the fridge.
 *
 * The comparison cannot be repaired here because the missing fact — how many
 * thighs are in a package — is not written down anywhere and would have to be
 * invented. So a shortfall is reported as advice for the cook and never as a
 * missing ingredient: `missing` and `ready` key on presence alone.
 */
export function cookable(items: Record<string, Item>, recipes: Recipe[]): Cookable[] {
  const scored = recipes.map((r) => {
    const needs: Need[] = r.needs.map(([id, want]) => {
      const it = items[id];
      const name = it?.name ?? id.replace(/-/g, " ");
      if (!it || it.gone) return { id, name, want, state: "out" as const };
      const short = want !== null && typeof it.qty === "number" && it.qty < want;
      return { id, name, want, state: short ? ("short" as const) : ("have" as const) };
    });
    const missing = needs.filter((n) => n.state === "out");
    return { recipe: r, needs, missing, ready: missing.length === 0 };
  });

  // Ready first, then real meals, then closest to ready, then quickest.
  //
  // The meal-kind rank matters more than it looks: sorting on time alone put
  // "chips and chipotle ranch" and a bowl of grapes at the top of a page whose
  // heading asks what we can make for dinner, because a snack is always going to
  // be the quickest thing in the house.
  const RANK: Record<string, number> = {
    dinner: 0,
    lunch: 1,
    side: 2,
    breakfast: 3,
    lighter: 4,
    snack: 5,
    dessert: 6,
  };
  const rank = (c: string) => RANK[c] ?? 3;
  return scored.sort(
    (a, b) =>
      Number(b.ready) - Number(a.ready) ||
      rank(a.recipe.cat) - rank(b.recipe.cat) ||
      a.missing.length - b.missing.length ||
      a.recipe.minutes - b.recipe.minutes,
  );
}

export type CompoundPair = {
  /** Stable id for the pairing itself, so a card can be linked to. */
  id: string;
  parent: Cookable;
  /** The child scored as if the parent had already been cooked. */
  child: Cookable;
  /** Leftover slugs the parent hands over. */
  via: string[];
  /**
   * True when cooking the parent tonight genuinely sets up the child, i.e. the
   * parent is cookable from stock AND the child needs nothing else missing.
   */
  ready: boolean;
};

/**
 * Every "cook this tonight, it becomes that tomorrow" pairing, scored forward.
 *
 * The child is deliberately scored against stock PLUS the parent's yields,
 * because on the evening the decision gets made the leftover does not exist
 * yet and never will unless the pair is cooked. Scoring it against today's
 * fridge is what made every compound meal read as un-makeable.
 *
 * Only pairs where the parent is worth cooking tonight are `ready`; the rest
 * still come back so the caller can show what a shopping trip would unlock.
 */
export function compoundPairs(items: Record<string, Item>, recipes: Recipe[]): CompoundPair[] {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const scored = new Map(cookable(items, recipes).map((c) => [c.recipe.id, c]));
  const out: CompoundPair[] = [];

  for (const child of recipes) {
    for (const parentId of child.from ?? []) {
      const parent = byId.get(parentId);
      // A `from` naming something that is not a recipe is a catalog error, not
      // a pairing. Skipping it silently would hide the typo forever; it shows up
      // as a missing pair, which is at least visible on the page.
      if (!parent) continue;
      // A pair is exactly two meals deep. The leftovers of a dish that was
      // itself made from leftovers are four or five days old by the time they
      // exist, which is past the point anybody should be eating them, and a
      // chain of them would keep proposing dinners off food that rotted. One
      // hand-off is the whole idea; a second is a different and worse idea.
      if (parent.from?.length) continue;
      const yields = (parent.yields ?? []).map(([slug]) => slug);
      const via = (child.needs ?? []).map(([slug]) => slug).filter((s) => yields.includes(s));
      if (!via.length) continue;

      // Pretend the parent has been cooked: its yields are on the shelf.
      const projected: Record<string, Item> = { ...items };
      for (const [slug, qty] of parent.yields ?? []) {
        projected[slug] = {
          ...(items[slug] ?? ({} as Item)),
          id: slug,
          name: items[slug]?.name ?? slug.replace(/-/g, " "),
          qty,
          gone: false,
          level: "full",
        } as Item;
      }
      const parentC = scored.get(parent.id);
      const childC = cookable(projected, [child])[0];
      if (!parentC || !childC) continue;
      out.push({
        id: `${parent.id}>${child.id}`,
        parent: parentC,
        child: childC,
        via,
        ready: parentC.ready && childC.ready,
      });
    }
  }

  // Cookable pairs first, then the ones closest to cookable.
  return out.sort(
    (a, b) =>
      Number(b.ready) - Number(a.ready) ||
      a.parent.missing.length +
        a.child.missing.length -
        (b.parent.missing.length + b.child.missing.length),
  );
}

/**
 * Recipe ids that only exist as the second half of a pair.
 *
 * These are deliberately kept OUT of the main grid. A second-night dish is not
 * a dinner you can decide to cook: it is what last night's dinner becomes, and
 * listing it beside real options put a page full of meals nobody could make at
 * the top of the thing that answers "what can we make". It belongs on its
 * parent's card, and it is reachable from there.
 */
export function childRecipeIds(recipes: Recipe[]): Set<string> {
  const ids = new Set(recipes.map((r) => r.id));
  return new Set(recipes.filter((r) => (r.from ?? []).some((p) => ids.has(p))).map((r) => r.id));
}

/** Catalog categories present, in a stable display order. */
export function recipeCats(recipes: Recipe[]): string[] {
  const order = ["dinner", "lunch", "lighter", "breakfast", "dessert", "side"];
  const found = [...new Set(recipes.map((r) => r.cat))];
  return [...order.filter((c) => found.includes(c)), ...found.filter((c) => !order.includes(c))];
}
