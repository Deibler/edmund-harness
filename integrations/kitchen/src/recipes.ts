/**
 * The meal catalog, and what can be cooked from live stock.
 *
 * The catalog is a JSON file rather than ledger events: a recipe is a standing
 * description of a dish, not something that happens. `needs` uses ledger slugs,
 * so cookability is an exact check. An ingredient the ledger has never heard of
 * reads as missing, never as available.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir, getAccount } from "./accounts.ts";
import { avoidedBy } from "./foods.ts";
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
   * Recipe ids whose leftovers this dish is built from (tonight's rice becoming
   * tomorrow's fried rice). Not gated on the leftover existing yet: the useful
   * decision is made the night before, when the parent is cooked. See
   * `compoundPairs`.
   */
  from?: string[];
  /**
   * Leftover slugs this dish produces, and roughly how much. The parent's half
   * of a compound pair; many dishes can yield the same leftover.
   */
  yields?: Array<[string, number | null]>;
  /** 1-5, hand-set by whoever curated the dish. Macros are too coarse to derive it. */
  health?: number;
  /**
   * How much of the day the dish asks for, as distinct from its minutes: a
   * walk-away braise is a weeknight, a stand-over risotto is not.
   */
  effort?: Effort;
  /** Where it cooks. */
  method?: Method;
  /** How many people one batch feeds, as written. */
  serves?: number;
  /**
   * Days one batch keeps feeding the household (the meal-prep axis). Distinct
   * from `yields`, which is about becoming a different dish.
   */
  feeds_days?: number;
  /** Months (1-12) the dish belongs to. Empty or absent means any time of year. */
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

/** The effort a dish states, or the one its minutes imply for older entries. */
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
 * True when one batch is meant to be eaten for days. Only meals qualify: a tray
 * of cookies keeps for days without feeding anyone for days.
 */
export function feedsAllWeek(r: Recipe): boolean {
  return MEAL_CATS.has(r.cat) && ((r.feeds_days ?? 1) >= 3 || r.method === "crockpot");
}

export type CookedSeed = { date: string; meal: string };

/**
 * The shared meal catalog, which lives with the skill. Resolved from this file's
 * location rather than `$HOME`, which launchd jobs do not reliably have.
 */
export function catalogPath(): string {
  return (
    process.env.KITCHEN_RECIPES ??
    join(import.meta.dir, "..", "..", "..", "skills", "kitchen", "recipes.json")
  );
}

/**
 * A household's own recipes, layered over the shared catalog. Per household
 * because a dish written for one kitchen's stock is not cookable in another.
 */
export function overlayPath(account: string): string {
  return join(accountDir(), account, "recipes.json");
}

/**
 * The shared catalog plus, for a household, its own overlay (which wins on an id
 * collision), minus anything on its avoid list.
 */
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
      // A malformed catalog costs the meal pages, not the whole site.
    }
  }
  if (!account) return { recipes, seed };

  // The avoid list is a hard filter on every path that offers a dish.
  const avoid = getAccount(account)?.diet?.avoid;
  const allowed = (r: Recipe) => !avoidedBy(avoid, r);

  const op = overlayPath(account);
  if (!existsSync(op)) return { recipes: recipes.filter(allowed), seed };
  try {
    const raw = JSON.parse(readFileSync(op, "utf8")) as { recipes?: Recipe[] };
    const own = raw.recipes ?? [];
    const mine = new Set(own.map((r) => r.id));
    return {
      recipes: [...recipes.filter((r) => !mine.has(r.id)), ...own].filter(allowed),
      seed,
    };
  } catch {
    return { recipes: recipes.filter(allowed), seed };
  }
}

export type Need = {
  id: string;
  name: string;
  want: number | null;
  /** "short" is advisory and never counts as missing; see `cookable`. */
  state: "have" | "short" | "out";
};

export type Cookable = {
  recipe: Recipe;
  needs: Need[];
  missing: Need[];
  /** True when every ingredient is present. */
  ready: boolean;
};

/**
 * Score every recipe against live stock, ready dishes first.
 *
 * Presence decides and quantity only advises. A recipe's want is a bare number
 * ("4" thighs) while the shelf holds "1 pkg"; the units cannot be reconciled, so
 * a shortfall is reported as "short" for the cook and never makes a dish
 * unready. A level-tracked staple (qty null) is available unless marked out.
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

  // Ready first, then real meals (a snack is always quickest, so time alone
  // would lead with snacks), then closest to ready, then quickest.
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
 * Every "cook this tonight, it becomes that tomorrow" pairing.
 *
 * The child is scored against stock plus the parent's yields, since the
 * leftover only exists once the parent is cooked. Pairs that are not ready are
 * still returned so the caller can show what shopping would unlock.
 */
export function compoundPairs(items: Record<string, Item>, recipes: Recipe[]): CompoundPair[] {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const scored = new Map(cookable(items, recipes).map((c) => [c.recipe.id, c]));
  const out: CompoundPair[] = [];

  for (const child of recipes) {
    for (const parentId of child.from ?? []) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      // Exactly two meals deep: leftovers of leftovers are too old to eat.
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
