/**
 * What the kitchen knows about food in general, independent of any household.
 *
 * Two questions live here:
 *
 * - How long something plausibly lasts where it is kept. Answered as a range,
 *   not a deadline: the low end is when a careful person starts wondering, the
 *   high end is past any reasonable doubt. Inventory reasoning (`evidence.ts`)
 *   works inside that range instead of treating one number as a fact.
 * - What role an item plays in a meal. Deli meat, sliced cheese and bread are
 *   lunch and snack food; a dinner is not built around them just because they
 *   are in stock.
 *
 * Matching is by keyword over the item's id and name, most specific rule first.
 */

import type { Category, Item, Location } from "./types.ts";

/** Plausible life in days, from "start wondering" to "certainly gone". */
export type Life = { low: number; high: number };

type LifeRule = {
  /** Word stems matched against the item's id and name. */
  match: RegExp;
  /** Lifetimes by storage location. Locations not listed fall back to `any`. */
  life: Partial<Record<Location | "any", Life>>;
  /**
   * Raw protein that is often frozen on arrival without anyone saying so. Past
   * its fridge life it is more likely in the freezer or cooked than rotting.
   */
  mayBeFrozen?: boolean;
};

const d = (low: number, high: number): Life => ({ low, high });

/** Most specific first. The first rule whose pattern matches wins. */
const LIFE_RULES: LifeRule[] = [
  { match: /\bleftover/, life: { fridge: d(3, 5), freezer: d(30, 90), any: d(3, 5) } },
  { match: /\b(deli|lunch ?meat|salami|pepperoni|bologna)\b/, life: { any: d(5, 10) } },
  {
    match: /\b(bacon|sausage|hot ?dog)/,
    life: { fridge: d(7, 14), freezer: d(60, 180), any: d(7, 14) },
    mayBeFrozen: true,
  },
  {
    match: /\b(chicken|turkey|pork|beef|steak|lamb|chops?|ground|filet|loin|thighs?|breasts?)\b/,
    life: { fridge: d(3, 6), freezer: d(90, 270), any: d(3, 6) },
    mayBeFrozen: true,
  },
  {
    match: /\b(salmon|tilapia|tuna|cod|shrimp|fish|crab|scallops?|seafood)\b/,
    life: { fridge: d(2, 4), freezer: d(60, 180), any: d(2, 4) },
    mayBeFrozen: true,
  },
  { match: /\beggs?\b/, life: { any: d(28, 50) } },
  { match: /\bmilk\b/, life: { any: d(7, 14) } },
  { match: /\b(yogurt|sour cream|cottage)\b/, life: { any: d(14, 28) } },
  {
    match: /\b(cream cheese|neufch|ricotta|mozzarella pearls|fresh mozzarella)\b/,
    life: { any: d(10, 21) },
  },
  { match: /\b(parmesan|cheddar|swiss|provolone|cheese|shredded)\b/, life: { any: d(21, 60) } },
  { match: /\bbutter\b/, life: { any: d(30, 90) } },
  {
    match: /\b(onions?|garlic|potato(es)?|sweet potato|squash|pumpkin)\b/,
    life: { counter: d(21, 60), pantry: d(21, 60), fridge: d(30, 75), any: d(21, 60) },
  },
  {
    match: /\b(lemons?|limes?|oranges?|mandarins?|citrus)\b/,
    life: { counter: d(7, 21), fridge: d(21, 45), any: d(10, 30) },
  },
  { match: /\bapples?\b/, life: { counter: d(7, 21), fridge: d(30, 60), any: d(14, 45) } },
  {
    match: /\b(melon|watermelon|cantaloupe)\b/,
    life: { counter: d(7, 14), fridge: d(4, 10), any: d(5, 14) },
  },
  { match: /\b(berries|strawberr|blueberr|raspberr|grapes?)\b/, life: { any: d(4, 10) } },
  { match: /\b(avocados?|bananas?|kiwi|peach|pear|plums?)\b/, life: { any: d(4, 10) } },
  {
    match: /\b(salad|greens|lettuce|spinach|arugula|basil|cilantro|scallions?|herbs?)\b/,
    life: { any: d(4, 10) },
  },
  { match: /\b(mushrooms?)\b/, life: { any: d(4, 9) } },
  {
    match: /\b(tomato(es)?|cucumbers?|zucchini|peppers?|corn on the cob|broccoli|cauliflower)\b/,
    life: { any: d(5, 14) },
  },
  { match: /\b(carrots?|celery|cabbage)\b/, life: { any: d(14, 35) } },
  { match: /\b(bread|rye|bagels?|buns?|rolls?)\b/, life: { freezer: d(60, 120), any: d(5, 12) } },
  { match: /\btortillas?\b/, life: { any: d(14, 45) } },
];

/** Category defaults, for anything no rule names. Null means it does not spoil on a kitchen timescale. */
const CATEGORY_LIFE: Record<Category, Life | null> = {
  produce: d(7, 21),
  meat: d(3, 6),
  seafood: d(2, 4),
  dairy: d(10, 30),
  bakery: d(5, 12),
  frozen: null,
  pantry: null,
  condiment: null,
  spice: null,
  drink: null,
  snack: null,
  other: d(7, 30),
};

const hay = (it: Pick<Item, "id" | "name">): string =>
  `${it.id.replace(/-/g, " ")} ${it.name}`.toLowerCase();

export type ShelfLife = {
  life: Life;
  /** True when a long silence more likely means "frozen or cooked" than "rotting". */
  mayBeFrozen: boolean;
};

/**
 * How long this item plausibly lasts where it is kept, or null when it does not
 * spoil on a timescale the kitchen reasons about (frozen food, pantry, spices).
 */
export function shelfLife(it: Pick<Item, "id" | "name" | "cat" | "loc">): ShelfLife | null {
  // The category decides whether it spoils at all: "chicken broth" in the pantry
  // must not pick up raw chicken's clock from the word it shares.
  if (CATEGORY_LIFE[it.cat] === null && !it.id.startsWith("leftover")) return null;
  const h = hay(it);
  const rule = LIFE_RULES.find((r) => r.match.test(h));
  if (rule) {
    if (it.loc === "freezer" && !rule.life.freezer) return null;
    const life = rule.life[it.loc] ?? rule.life.any;
    if (life) return { life, mayBeFrozen: Boolean(rule.mayBeFrozen) && it.loc !== "freezer" };
  }
  if (it.loc === "freezer") return null;
  const life = CATEGORY_LIFE[it.cat];
  return life
    ? { life, mayBeFrozen: (it.cat === "meat" || it.cat === "seafood") && it.loc === "fridge" }
    : null;
}

/* ------------------------------------------------------------------ *
 * Meal roles
 * ------------------------------------------------------------------ */

/**
 * Food people eat as-is at lunch or as a snack. It can appear in a dinner, but a
 * dinner is never chosen because of it, and an expiring pack of it does not
 * make a dinner urgent.
 */
const CONVENIENCE =
  /\b(deli|lunch ?meat|lunchables|salami|pepperoni|bologna|hot ?dogs?|meat sticks?|sliced (cheese|turkey|ham)|bread|rye|bagels?|chips|pretzels?|crackers?|granola|trail mix|snacks?|cookies?|candy|chocolate|ice cream|yogurt|soda|cola|coffee|espresso|seaweed)\b/;

export function isConvenience(it: Pick<Item, "id" | "name" | "cat">): boolean {
  if (it.cat === "snack" || it.cat === "drink") return true;
  return CONVENIENCE.test(hay(it));
}

/* ------------------------------------------------------------------ *
 * Pantry basics
 * ------------------------------------------------------------------ */

/**
 * Ingredients a recipe may name without the ledger tracking them: every
 * kitchen has them, and nobody logs buying salt. This is the one definition:
 * saving an idea accepts them, `onHand` counts them as present, and pruning
 * never retires a dish for lacking one.
 */
export const PANTRY_BASICS: ReadonlySet<string> = new Set([
  "salt",
  "black-pepper",
  "pepper",
  "water",
  "cooking-oil",
  "olive-oil",
  "vegetable-oil",
  "all-purpose-flour",
  "flour",
  "sugar",
  "granulated-sugar",
]);

export const isPantryBasic = (slug: string): boolean => PANTRY_BASICS.has(slug);

/**
 * Whether an ingredient is in the kitchen, as far as cooking is concerned.
 *
 * The ledger decides anything it tracks, basics included: a household that
 * logged salt and later said it ran out has told us more than the assumption.
 * An untracked basic is present; anything else untracked is missing.
 */
export function onHand(items: Readonly<Record<string, Pick<Item, "gone">>>, slug: string): boolean {
  const it = items[slug];
  if (it) return !it.gone;
  return isPantryBasic(slug);
}

/* ------------------------------------------------------------------ *
 * The avoid list
 * ------------------------------------------------------------------ */

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Plural spellings of a singular word. Bogus ones ("mushroomes") match nothing. */
function pluralsOf(w: string): string[] {
  const out = [`${w}s`, `${w}es`];
  if (/[^aeiou]y$/.test(w)) out.push(`${w.slice(0, -1)}ies`); // berry -> berries
  if (w.endsWith("f")) out.push(`${w.slice(0, -1)}ves`); // leaf -> leaves
  if (w.endsWith("fe")) out.push(`${w.slice(0, -2)}ves`); // knife -> knives
  return out;
}

/**
 * Singular spellings of a word that may be plural. Words ending in -ss, -us or
 * -is are not plurals (glass, asparagus, hummus), so they have none.
 */
function singularsOf(w: string): string[] {
  if (w.length < 3 || /(ss|us|is)$/.test(w) || !w.endsWith("s")) return [];
  const out = [w.slice(0, -1)]; // mushrooms -> mushroom, olives -> olive, peas -> pea
  if (w.endsWith("ies")) out.push(`${w.slice(0, -3)}y`); // berries -> berry
  if (w.endsWith("ves")) out.push(`${w.slice(0, -3)}f`, `${w.slice(0, -3)}fe`); // leaves, knives
  if (/(o|ch|sh|x|z|ss)es$/.test(w)) out.push(w.slice(0, -2)); // tomatoes, peaches, glasses
  return out;
}

/**
 * Whether a household's avoid list rules this dish out, and by which term.
 *
 * Matched by whole words against the dish name and each ingredient (slug or
 * written name), so "tomato paste" catches `tomato-paste` without catching
 * `tomatoes-on-the-vine`, and "pea" never catches "peach".
 *
 * Number is forgiven in the direction that is safe. The term as written and
 * its plural match anywhere: "mushroom" catches `cremini-mushrooms` and
 * `mushroom-soup`. A plural term's singular matches only as the ingredient
 * itself, its last word: "mushrooms" catches `mushroom`, but "olives" does not
 * catch `olive-oil` and "greens" does not catch `green-beans`, because a
 * singular noun in front of another is usually an attribute, not the food.
 */
export function avoidedBy(
  avoid: readonly string[] | undefined,
  dish: {
    name: string;
    needs?: ReadonlyArray<readonly [string, unknown]>;
    /** Extra ingredient phrases, e.g. a written recipe's ingredient names. */
    also?: readonly string[];
  },
): string | null {
  if (!avoid?.length) return null;
  const ingredients = [...(dish.needs ?? []).map(([slug]) => slug), ...(dish.also ?? [])]
    .map(words)
    .filter((w) => w.length);
  const phrases = [
    { w: words(dish.name), ingredient: false },
    ...ingredients.map((w) => ({ w, ingredient: true })),
  ];
  for (const raw of avoid) {
    const term = words(raw);
    if (!term.length) continue;
    const lead = term.slice(0, -1);
    const last = term[term.length - 1]!;
    const anywhere = new Set([last, ...pluralsOf(last)]);
    const asHead = new Set(singularsOf(last));
    const hit = phrases.some(({ w, ingredient }) => {
      for (let i = 0; i + term.length <= w.length; i++) {
        if (!lead.every((t, k) => w[i + k] === t)) continue;
        const end = w[i + lead.length]!;
        if (anywhere.has(end)) return true;
        if (ingredient && i + term.length === w.length && asHead.has(end)) return true;
      }
      return false;
    });
    if (hit) return raw;
  }
  return null;
}
