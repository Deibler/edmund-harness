/**
 * Calorie and macro estimates for logged food, derived from what the ledger
 * already records (item, category, how much a meal used) so nobody has to weigh
 * or look anything up.
 *
 * Every figure carries a basis: "table" (matched by id), "category" (a category
 * average), or "unknown" (contributes nothing). A total built mostly from
 * category averages is a ballpark and must be presented as one.
 */

export type Macro = { kcal: number; protein: number; carb: number; fat: number };
/**
 * `carried`: a leftover, counted when it was cooked, so zero here and excluded
 * from confidence. `mismatched-unit`: a use recorded in a unit other than the
 * stocking unit, which contributes nothing rather than a wrong number.
 */
export type Basis = "table" | "category" | "carried" | "mismatched-unit" | "unknown";

/**
 * Per one stocking unit (a bag, a jug, a package, one egg). Portions come from
 * the qty on the use event.
 */
const TABLE: Record<string, Macro> = {
  // proteins
  "chicken-breasts": { kcal: 1100, protein: 210, carb: 0, fat: 24 },
  "boneless-skinless-chicken-thighs": { kcal: 1200, protein: 180, carb: 0, fat: 50 },
  "jfm-buffalo-style-chicken-breast": { kcal: 700, protein: 130, carb: 8, fat: 14 },
  "ground-beef-96-4": { kcal: 620, protein: 100, carb: 0, fat: 22 },
  "thin-cut-boneless-pork-chops": { kcal: 900, protein: 150, carb: 0, fat: 32 },
  "cedar-plank-atlantic-salmon": { kcal: 640, protein: 68, carb: 0, fat: 40 },
  "cooked-shrimp-peeled-tail-on": { kcal: 7, protein: 1.4, carb: 0, fat: 0.1 },
  "imitation-crab-legs": { kcal: 400, protein: 32, carb: 56, fat: 2 },
  "deli-honey-ham": { kcal: 380, protein: 56, carb: 16, fat: 10 },
  "deli-provolone": { kcal: 700, protein: 50, carb: 4, fat: 54 },
  eggs: { kcal: 72, protein: 6.3, carb: 0.4, fat: 5 },
  "schmidt-s-meat-sticks": { kcal: 900, protein: 60, carb: 6, fat: 70 },
  // dairy
  milk: { kcal: 1200, protein: 64, carb: 96, fat: 64 },
  butter: { kcal: 3250, protein: 4, carb: 0, fat: 368 },
  "cream-cheese": { kcal: 800, protein: 14, carb: 12, fat: 80 },
  "grated-parmesan": { kcal: 1000, protein: 80, carb: 8, fat: 68 },
  "shredded-mozzarella": { kcal: 1120, protein: 80, carb: 8, fat: 88 },
  "shredded-mexican-4-cheese-blend": { kcal: 1120, protein: 76, carb: 12, fat: 88 },
  "sour-cream": { kcal: 480, protein: 6, carb: 12, fat: 46 },
  "yoplait-light-vanilla-yogurt": { kcal: 90, protein: 5, carb: 15, fat: 0 },
  "plain-light-yogurt": { kcal: 110, protein: 12, carb: 14, fat: 0 },
  // starch
  "boil-in-bag-white-rice": { kcal: 640, protein: 13, carb: 143, fat: 1 },
  "long-grain-white-rice": { kcal: 2200, protein: 44, carb: 490, fat: 4 },
  "instant-rice": { kcal: 1800, protein: 36, carb: 400, fat: 3 },
  "cheese-tortellini-2-pack": { kcal: 1100, protein: 44, carb: 160, fat: 30 },
  penne: { kcal: 1600, protein: 56, carb: 320, fat: 8 },
  spaghetti: { kcal: 1600, protein: 56, carb: 320, fat: 8 },
  "wide-egg-noodles": { kcal: 1200, protein: 44, carb: 230, fat: 14 },
  "garden-rotini": { kcal: 1600, protein: 56, carb: 320, fat: 8 },
  "wheat-bread": { kcal: 1200, protein: 48, carb: 220, fat: 16 },
  "flour-tortillas": { kcal: 140, protein: 4, carb: 24, fat: 3.5 },
  "soft-whole-wheat-taco-tortillas": { kcal: 120, protein: 4, carb: 20, fat: 3 },
  "italian-breadcrumbs": { kcal: 1700, protein: 56, carb: 320, fat: 20 },
  "all-purpose-flour": { kcal: 1650, protein: 45, carb: 345, fat: 4 },
  // produce
  "yellow-onions": { kcal: 44, protein: 1.2, carb: 10, fat: 0.1 },
  "red-onion": { kcal: 44, protein: 1.2, carb: 10, fat: 0.1 },
  avocados: { kcal: 240, protein: 3, carb: 12, fat: 22 },
  apples: { kcal: 95, protein: 0.5, carb: 25, fat: 0.3 },
  bananas: { kcal: 105, protein: 1.3, carb: 27, fat: 0.4 },
  kiwi: { kcal: 42, protein: 0.8, carb: 10, fat: 0.4 },
  cucumbers: { kcal: 45, protein: 2, carb: 11, fat: 0.3 },
  "tomatoes-on-the-vine": { kcal: 22, protein: 1.1, carb: 4.8, fat: 0.2 },
  scallions: { kcal: 32, protein: 1.8, carb: 7, fat: 0.2 },
  "mini-sweet-peppers": { kcal: 130, protein: 5, carb: 30, fat: 1 },
  "sliced-mushrooms": { kcal: 60, protein: 8, carb: 9, fat: 1 },
  "bagged-salad-greens": { kcal: 70, protein: 6, carb: 12, fat: 1 },
  "seedless-watermelon": { kcal: 1400, protein: 28, carb: 350, fat: 7 },
  garlic: { kcal: 45, protein: 2, carb: 10, fat: 0.2 },
  lemons: { kcal: 100, protein: 4, carb: 32, fat: 1 },
  limes: { kcal: 100, protein: 2, carb: 34, fat: 0.5 },
  // frozen veg
  "frozen-broccoli-florets": { kcal: 200, protein: 18, carb: 36, fat: 2 },
  "frozen-green-beans": { kcal: 180, protein: 10, carb: 40, fat: 0.6 },
  "frozen-peas": { kcal: 400, protein: 26, carb: 70, fat: 2 },
  "frozen-corn": { kcal: 500, protein: 16, carb: 110, fat: 6 },
  "frozen-mixed-vegetables": { kcal: 300, protein: 16, carb: 60, fat: 2 },
  "frozen-brussels-sprouts": { kcal: 220, protein: 16, carb: 44, fat: 2 },
  "strawberry-banana-smoothie-fruit": { kcal: 400, protein: 6, carb: 96, fat: 2 },
  // pantry / fat / sugar
  "extra-virgin-olive-oil": { kcal: 4000, protein: 0, carb: 0, fat: 450 },
  "avocado-oil": { kcal: 4000, protein: 0, carb: 0, fat: 450 },
  mayo: { kcal: 2400, protein: 2, carb: 4, fat: 270 },
  "granulated-sugar": { kcal: 774, protein: 0, carb: 200, fat: 0 },
  "dark-brown-sugar": { kcal: 830, protein: 0, carb: 214, fat: 0 },
  "powdered-sugar": { kcal: 470, protein: 0, carb: 120, fat: 0 },
  "chocolate-chips": { kcal: 2400, protein: 24, carb: 300, fat: 140 },
  "walnut-halves-pieces": { kcal: 1850, protein: 43, carb: 39, fat: 185 },
  "diced-tomatoes": { kcal: 80, protein: 4, carb: 18, fat: 0.5 },
  "tomato-paste": { kcal: 150, protein: 8, carb: 34, fat: 1 },
  "black-beans": { kcal: 350, protein: 22, carb: 62, fat: 1.5 },
  "baked-beans": { kcal: 560, protein: 26, carb: 106, fat: 4 },
  "chicken-broth": { kcal: 40, protein: 6, carb: 2, fat: 1 },
  "mild-salsa": { kcal: 120, protein: 4, carb: 26, fat: 1 },
  "yum-yum-sauce": { kcal: 1600, protein: 2, carb: 60, fat: 150 },
  "roasted-seaweed-squares": { kcal: 100, protein: 6, carb: 6, fat: 6 },
  "herr-s-sour-cream-onion-baked-chips": { kcal: 1100, protein: 16, carb: 180, fat: 36 },
  "sunbelt-oats-honey-granola-bars": { kcal: 1200, protein: 20, carb: 200, fat: 40 },
  "mrs-fields-cookie-dough": { kcal: 1800, protein: 18, carb: 250, fat: 80 },
  "dark-chocolate-peanut-butter-buckeyes": { kcal: 1400, protein: 24, carb: 140, fat: 84 },
  "butter-braided-pretzels": { kcal: 1300, protein: 34, carb: 260, fat: 12 },
  "light-whipped-topping": { kcal: 600, protein: 0, carb: 60, fat: 40 },
  "espresso-drinks-4-pack": { kcal: 560, protein: 20, carb: 84, fat: 16 },
  "coke-zero-10-pack": { kcal: 0, protein: 0, carb: 0, fat: 0 },
};

/**
 * Category fallbacks per unit, so an unmatched item degrades to a labelled
 * ballpark. Condiments and spices are near zero on purpose.
 */
const BY_CATEGORY: Record<string, Macro> = {
  produce: { kcal: 60, protein: 2, carb: 14, fat: 0.3 },
  meat: { kcal: 800, protein: 130, carb: 0, fat: 30 },
  seafood: { kcal: 500, protein: 80, carb: 4, fat: 16 },
  dairy: { kcal: 600, protein: 30, carb: 30, fat: 40 },
  frozen: { kcal: 300, protein: 14, carb: 55, fat: 3 },
  bakery: { kcal: 1200, protein: 40, carb: 220, fat: 16 },
  pantry: { kcal: 900, protein: 24, carb: 160, fat: 16 },
  snack: { kcal: 1100, protein: 16, carb: 160, fat: 45 },
  drink: { kcal: 200, protein: 2, carb: 45, fat: 1 },
  condiment: { kcal: 40, protein: 0.4, carb: 6, fat: 1.5 },
  spice: { kcal: 5, protein: 0.2, carb: 1, fat: 0.1 },
  other: { kcal: 300, protein: 10, carb: 40, fat: 10 },
};

const ZERO: Macro = { kcal: 0, protein: 0, carb: 0, fat: 0 };

export function macroFor(itemId: string, cat?: string): { macro: Macro; basis: Basis } {
  const hit = TABLE[itemId];
  if (hit) return { macro: hit, basis: "table" };
  // Leftovers were counted when the meal was cooked.
  if (itemId.startsWith("leftover-")) return { macro: ZERO, basis: "carried" };
  const byCat = cat ? BY_CATEGORY[cat] : undefined;
  if (byCat) return { macro: byCat, basis: "category" };
  return { macro: ZERO, basis: "unknown" };
}

export type MacroTotal = Macro & {
  /** How many contributing items were exact table hits vs category guesses. */
  fromTable: number;
  fromCategory: number;
  unknown: number;
  /** Leftovers, counted at cook time and deliberately zero here. */
  carried: number;
  /** Uses whose unit did not match the item's stocking unit, so were not scaled. */
  mismatched: number;
};

export function emptyTotal(): MacroTotal {
  return { ...ZERO, fromTable: 0, fromCategory: 0, unknown: 0, carried: 0, mismatched: 0 };
}

/**
 * Add `qty` units of an item into a running total. When the use was recorded in
 * a different unit from the stocking unit the figures are per (11 tbsp against
 * a per-pound butter row), nothing is added and the item counts as mismatched.
 */
export function addTo(
  total: MacroTotal,
  itemId: string,
  qty: number | null,
  cat?: string,
  useUnit?: string | null,
  stockUnit?: string | null,
): MacroTotal {
  let { macro, basis } = macroFor(itemId, cat);
  const norm = (u?: string | null) => (u ?? "").trim().toLowerCase();
  const scaled = qty !== null && qty !== 1;
  if (scaled && norm(useUnit) && norm(stockUnit) && norm(useUnit) !== norm(stockUnit)) {
    macro = ZERO;
    basis = "mismatched-unit";
  }
  // A null qty means "all of it": one container's worth.
  const n = qty === null ? 1 : qty;
  total.kcal += macro.kcal * n;
  total.protein += macro.protein * n;
  total.carb += macro.carb * n;
  total.fat += macro.fat * n;
  if (basis === "table") total.fromTable += 1;
  else if (basis === "category") total.fromCategory += 1;
  else if (basis === "carried") total.carried += 1;
  else if (basis === "mismatched-unit") total.mismatched += 1;
  else total.unknown += 1;
  return total;
}

/**
 * How much of a total rests on table hits, 0..1. Leftovers are excluded from
 * both sides: they are a deliberate zero, not a measurement.
 */
export function confidence(t: MacroTotal): number {
  const n = t.fromTable + t.fromCategory + t.unknown + t.mismatched;
  return n ? t.fromTable / n : 0;
}

export function describeConfidence(t: MacroTotal): string {
  const n = t.fromTable + t.fromCategory + t.unknown + t.mismatched;
  if (!n) {
    return t.carried
      ? "not countable — everything logged was leftovers, already counted when it was cooked"
      : "nothing logged to count";
  }
  const c = confidence(t);
  const tail = t.mismatched
    ? ` (${t.mismatched} item(s) logged in a unit the table cannot scale, left out)`
    : "";
  if (c >= 0.8) return `good — most items matched by name${tail}`;
  if (c >= 0.5) return `rough — a fair share fell back to category averages${tail}`;
  return `very rough — mostly category averages, treat as a ballpark${tail}`;
}
