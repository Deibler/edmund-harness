/**
 * The recipe page is the thing somebody is holding while they cook, and it is
 * the only part of this system whose bugs are invisible to every other test:
 * the ledger can be perfect and the page still unreadable.
 *
 * Both defects reported so far were the same shape. Three items sized to their
 * own content on one row, so a wordy amount ate the width, the ingredient name
 * collapsed to one word per line, and the stock badge printed on top of it —
 * once in the per-step lists, then again in the overview list. So what is
 * asserted here is the layout CONTRACT rather than any particular pixel: every
 * ingredient row is the same shape, the amount has its own line, and nothing
 * competes with the name for width. A future change that reintroduces a row
 * whose layout depends on how long its text happens to be fails here.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-page-"));
process.env.KITCHEN_DIR = BASE;
mkdirSync(join(BASE, "tenants", "t"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: {
      t: { name: "test", created: "2026-01-01T00:00:00+00:00", members: ["p"] },
    },
  }),
);

const { renderRecipePage } = await import("../src/recipepage.ts");
import type { Item } from "../src/types.ts";
import { check, section } from "./harness.ts";

const recipe = {
  id: "test-dish",
  base: null,
  name: "Test dish",
  desc: "A dish.",
  minutes: 20,
  serves: 2,
  cat: "dinner",
  built: "2026-08-17T00:00:00.000Z",
  needs: [
    ["chicken", 1],
    ["butter", 1],
  ] as Array<[string, number | null]>,
  ingredients: [
    // The exact line that broke the page: a sentence where a measurement goes.
    {
      name: "Boneless skinless chicken thighs",
      amount: "the whole package, about 6 thighs",
      item: "chicken",
      note: "Thighs, not breasts. They forgive an extra minute in the pan.",
    },
    { name: "Butter", amount: "4 tablespoons", item: "butter" },
    // Untracked, so no stock badge at all.
    { name: "Salt", amount: "to taste" },
  ],
  steps: [
    {
      n: 1,
      title: "Season",
      body: "Season the thighs.",
      uses: [{ ingredient: "Boneless skinless chicken thighs", amount: "all 6" }],
    },
    { n: 2, title: "Sear", body: "Sear them.", uses: [{ ingredient: "Butter", amount: "2 tbsp" }] },
  ],
};

const items: Record<string, Item> = {
  chicken: { id: "chicken", name: "Chicken thighs", qty: 1, unit: "package" } as Item,
  butter: { id: "butter", name: "Butter", qty: 1, unit: "stick", gone: true } as Item,
};

const html = renderRecipePage(recipe, {
  items,
  prices: new Map(),
  title: "Test kitchen",
});

/* ── one row shape ───────────────────────────────────────────────────────── */

// The first fix stacked only the rows whose amount ran past 16 characters,
// which left the list alternating between two layouts and turned on a number
// somebody would have to re-tune the first time an amount got wordier. Every
// row carrying the same class is what makes that impossible to reintroduce
// without this failing.
section("ingredient rows");

const rowClasses = [...html.matchAll(/<div class="(ing[^"]*)"/g)].map((m) => m[1] ?? "");
check("every ingredient renders a row", rowClasses.length === recipe.ingredients.length);
check("and every row is the same shape, whatever its text", new Set(rowClasses).size === 1);
check("with no length-dependent modifier", !rowClasses.some((c) => c.includes("long")));

/* ── the amount cannot steal the name's width ────────────────────────────── */

section("row layout");

const ingCss = html.slice(html.indexOf(".ing{"), html.indexOf(".ing{") + 700);
check(
  "the row is a grid, not three items each sizing to their own content",
  /\.ing\{[^}]*display:grid/.test(ingCss),
);
check(
  "the name column can shrink to nothing rather than forcing the row wider",
  /grid-template-columns:minmax\(0,1fr\)/.test(ingCss),
);
check(
  "the amount gets its own line, so it never competes with the name",
  /\.ing \.amt\{[^}]*grid-row:2/.test(ingCss),
);
check(
  "the amount spans the full width of that line",
  /\.ing \.amt\{[^}]*grid-column:1\/-1/.test(ingCss),
);
check(
  "a long unbroken amount wraps instead of overflowing the card",
  /\.ing \.amt\{[^}]*overflow-wrap:anywhere/.test(ingCss),
);
check(
  "the stock badge is pinned to its own column and cannot land on the name",
  /\.ing \.st\{[^}]*grid-column:2/.test(ingCss) && /\.ing \.st\{[^}]*justify-self:end/.test(ingCss),
);

// A variant link is a name and a reason, no amount and no stock. It shared the
// class and would have inherited the ingredient grid.
check(
  "variant links do not reuse the ingredient row",
  html.includes(".vrow{") && !/<a class="ing"/.test(html),
);

/* ── what the row says ───────────────────────────────────────────────────── */

section("stock honesty");

check("a tracked ingredient in the house reads have", html.includes(">have<"));
check("a tracked ingredient that is gone reads out", html.includes(">out<"));
// Salt is not tracked and never will be. Flagging it would train people to
// ignore the colour on the lines that matter, so it gets no badge.
check(
  "only the tracked lines get a badge, so the colour keeps its meaning",
  (html.match(/class="st"/g) ?? []).length === 2,
);
check("the note stays with its ingredient", html.includes("Thighs, not breasts."));
check("the amount is rendered, not dropped", html.includes("the whole package, about 6 thighs"));

/* ── a written slug that is really a display name ────────────────────────── */

// The failure this pins, from 2026-08-17: a recipe was saved with `item` and
// `needs` carrying display names ("Boneless skinless chicken thighs") instead of
// ledger slugs. Every lookup missed, and a miss is indistinguishable from an
// item the house has run out of, so the page rendered EVERY line "out" over a
// full fridge and told two people to go shopping. The old back-fill could not
// help, because it only repaired lines whose slug was absent and these had one
// that was merely wrong.

section("display names resolve to slugs");

const named = {
  ...recipe,
  needs: [
    ["Chicken thighs", 1],
    ["Butter", 1],
  ] as Array<[string, number | null]>,
  ingredients: [
    { name: "Chicken thighs", amount: "4 thighs", item: "Chicken thighs" },
    { name: "Butter", amount: "2 tablespoons", item: "Butter" },
    { name: "Salt", amount: "to taste", item: "Salt" },
  ],
  // Its own steps, naming its own ingredients. Reusing the fixture's steps
  // would leave `uses` pointing at names this recipe does not have, and the
  // badge counts below would then be measuring the mismatch instead of the fix.
  steps: [
    {
      n: 1,
      title: "Season",
      body: "Season the thighs.",
      uses: [{ ingredient: "Chicken thighs", amount: "all 4" }],
    },
    { n: 2, title: "Sear", body: "Sear them.", uses: [{ ingredient: "Butter", amount: "2 tbsp" }] },
  ],
};

const namedHtml = renderRecipePage(named, {
  items: {
    "chicken-thighs": { id: "chicken-thighs", name: "Chicken thighs", qty: 1, unit: "pkg" } as Item,
    butter: { id: "butter", name: "Butter", qty: 1, unit: "stick" } as Item,
  },
  prices: new Map(),
  title: "Test kitchen",
});

check("a display name in `item` still finds the item on the shelf", namedHtml.includes(">have<"));
// The count that matters. Badges also render inside the per-step lists, so the
// number of "have" labels tracks how many steps mention a tracked ingredient,
// which is not what is being tested here. Zero "out" over a full fridge is.
check("and nothing in a full fridge is reported out", !namedHtml.includes(">out<"));
// Salt resolves nowhere. It must fall back to untracked rather than staying
// pointed at a dead key, which is what printed "out" on every staple.
check(
  "a slug that resolves nowhere is untracked, not missing",
  (namedHtml.match(/class="st"/g) ?? []).length === 2,
);

// The repair must not be able to invent stock. A dish needing something the
// ledger has never heard of is a real shortfall and has to keep saying so.
const absent = renderRecipePage(
  {
    ...named,
    needs: [["Saffron", 1]] as Array<[string, number | null]>,
    ingredients: [{ name: "Saffron", amount: "a pinch", item: "Saffron" }],
  },
  { items: {}, prices: new Map(), title: "Test kitchen" },
);
check("an ingredient the ledger has never tracked still reads out", absent.includes(">out<"));
