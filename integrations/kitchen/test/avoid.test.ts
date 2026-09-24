/**
 * The avoid list filters every path that offers a dish, and only those.
 *
 * It used to sit inside `loadRecipes`, which both missed the recipes written
 * for the house (they are added to the pool separately, so the dinner text
 * picked an avoided marinara) and hid dishes from code that only needed to look
 * one up (a cooked avoided dish then left no leftovers). These pin both halves,
 * the save-time warning, the explore shelf, and how a term matches its plural
 * or singular without catching unrelated food.
 *
 * Runs against a scratch KITCHEN_DIR with its own catalog.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-avoid-"));
const SITE = mkdtempSync(join(tmpdir(), "kitchen-avoid-site-"));
const SAM = "imessage:dm:+15550000002";
process.env.KITCHEN_DIR = BASE;
process.env.KITCHEN_RECIPES = join(BASE, "catalog.json");
writeFileSync(
  process.env.KITCHEN_RECIPES,
  JSON.stringify({
    recipes: [
      // Not cookable (no beef), so without a filter the ready marinara wins.
      {
        id: "beef-stew",
        name: "Beef stew",
        desc: "",
        minutes: 90,
        cat: "dinner",
        needs: [["beef", 1]],
      },
      {
        id: "baked-ziti",
        name: "Baked ziti",
        desc: "",
        minutes: 45,
        cat: "dinner",
        needs: [
          ["tomato-paste", 1],
          ["penne", 1],
        ],
        yields: [["leftover-ziti", 2]],
      },
      // Harmless as a card; the version written for this house adds tomato paste.
      {
        id: "garlic-spaghetti",
        name: "Garlic spaghetti",
        desc: "",
        minutes: 20,
        cat: "dinner",
        needs: [["spaghetti", 1]],
      },
    ],
  }),
);
mkdirSync(join(BASE, "tenants", "av"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: {
      av: {
        name: "av",
        created: "2026-01-01T00:00:00+00:00",
        members: [SAM],
        diet: { avoid: ["tomato paste"] },
        site: { artifact: SITE, url: null },
      },
    },
  }),
);

const { getAccount, updateAccount } = await import("../src/accounts.ts");
const { saveRecipe, getRecipe } = await import("../src/cookbook.ts");
const { saveExplore, exploreShelf } = await import("../src/explore.ts");
const { avoidedBy } = await import("../src/foods.ts");
const { confirmPlan, yieldsOf } = await import("../src/plans.ts");
const { loadRecipes, menu } = await import("../src/recipes.ts");
const { pickFor } = await import("../src/schedules.ts");
const { shopping } = await import("../src/shopping.ts");
const { renderSite } = await import("../src/site.ts");
const { append, fold } = await import("../src/store.ts");
const { kitchenTools } = await import("../tools.ts");

const A = "av";
const add = (id: string, name: string, src = "receipt:shop-2026-09-20") =>
  append(A, [
    {
      op: "add",
      item: id,
      qty: 1,
      unit: "ct",
      fields: { name, cat: "pantry", loc: "pantry" },
      src,
    },
  ]);
add("tomato-paste", "Tomato paste");
add("spaghetti", "Spaghetti");
add("penne", "Penne");
// Penne ran out: buying it would "open up" the avoided ziti.
append(A, [{ op: "use", item: "penne", qty: null, why: "finished" }]);

const marinara = {
  id: "marinara",
  base: null,
  name: "Weeknight marinara",
  desc: "",
  minutes: 30,
  serves: 2,
  cat: "dinner",
  needs: [
    ["tomato-paste", null],
    ["spaghetti", null],
  ] as Array<[string, number | null]>,
  ingredients: [
    { name: "Tomato paste", amount: "2 tbsp", item: "tomato-paste" },
    { name: "Spaghetti", amount: "1 lb", item: "spaghetti" },
  ],
  steps: [{ n: 1, title: "Cook", body: "Cook it.", uses: [] }],
};
saveRecipe(A, marinara);
saveRecipe(A, {
  ...marinara,
  id: "garlic-spaghetti",
  name: "Garlic spaghetti",
  needs: [["spaghetti", null]],
  ingredients: [
    { name: "Spaghetti", amount: "1 lb", item: "spaghetti" },
    { name: "Tomato paste", amount: "1 tbsp, for color" },
  ],
});

describe("every path that offers a dish applies the avoid list", () => {
  test("a written recipe is not on the menu", () => {
    expect(menu(A).map((r) => r.id)).not.toContain("marinara");
  });
  test("nor a catalog card whose written version uses it, even only in its lines", () => {
    expect(menu(A).map((r) => r.id)).not.toContain("garlic-spaghetti");
  });
  test("the dinner text never picks it", () => {
    expect(pickFor(A, getAccount(A)!, "dinner")?.recipe.id).toBe("beef-stew");
  });
  test("the home page does not rank it", () => {
    const html = renderSite(A, getAccount(A)!);
    const raw = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const data = JSON.parse(raw) as { cook: Record<string, unknown> };
    expect(Object.keys(data.cook)).not.toContain("marinara");
    expect(Object.keys(data.cook)).not.toContain("baked-ziti");
    expect(Object.keys(data.cook)).toContain("beef-stew");
  });
  test("an avoided dish never makes something worth buying", () => {
    expect(shopping(A).suggestions.map((s) => s.item)).not.toContain("penne");
  });
  test("saving a written recipe that uses it says so, and still saves it", async () => {
    const tool = kitchenTools({
      sessionKey: SAM,
      config: { kitchen: { enabled: true, dir: BASE }, paths: { data_dir: BASE } },
    } as never).find((t) => t.name === "kitchen_recipe_save")!;
    const res = (await tool.handler({ ...marinara, id: "marinara-2" } as never)) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0]!.text).toContain("AVOIDED: this uses tomato paste");
    expect(getRecipe(A, "marinara-2")).not.toBeNull();
  });
  test("the explore shelf drops a dish that uses it", () => {
    const dish = (name: string, buy: string[]) => ({
      name,
      desc: "",
      cuisine: "x",
      why: "",
      buy,
      have: [],
      minutes: 30,
      effort: "weeknight",
      method: "stovetop",
      spend: 2,
      health: 3,
    });
    const res = saveExplore(A, [
      dish("Shakshuka", ["eggs", "tomato paste"]),
      dish("Bibimbap", ["gochujang", "rice"]),
    ]);
    expect(res.set.dishes.map((d) => d.name)).toEqual(["Bibimbap"]);
    expect(res.avoided).toEqual(["Shakshuka (tomato paste)"]);
  });
  test("and a shelf saved before the avoid list changed is filtered when shown", () => {
    updateAccount(A, { diet: { avoid: ["tomato paste", "gochujang"] } });
    expect(exploreShelf(A)?.dishes ?? []).toEqual([]);
    updateAccount(A, { diet: { avoid: ["tomato paste"] } });
  });
});

describe("looking a dish up ignores the avoid list", () => {
  test("the catalog still has the avoided dish", () => {
    expect(loadRecipes(A).recipes.map((r) => r.id)).toContain("baked-ziti");
  });
  test("confirming one that was cooked leaves its leftovers", () => {
    expect(yieldsOf(A, "Baked ziti")).toEqual([["leftover-ziti", 2]]);
    confirmPlan(A, "p-ziti", { meal: "Baked ziti", lines: [{ item: "tomato-paste", qty: 1 }] });
    expect(fold(A)["leftover-ziti"]?.gone).toBe(false);
  });
});

describe("an avoid term forgives singular and plural, and nothing else", () => {
  const hits = (term: string, name: string, ...slugs: string[]) =>
    avoidedBy([term], { name, needs: slugs.map((s) => [s, null] as const) }) !== null;

  test("a singular term catches the plural", () => {
    expect(hits("mushroom", "Stroganoff", "cremini-mushrooms")).toBe(true);
    expect(hits("tomato", "Salad", "cherry-tomatoes")).toBe(true);
    expect(hits("berry", "Parfait", "mixed-berries")).toBe(true);
    expect(hits("bay leaf", "Stock", "bay-leaves")).toBe(true);
  });
  test("a plural term catches the singular", () => {
    expect(hits("mushrooms", "Stroganoff", "mushroom")).toBe(true);
    expect(hits("tomatoes", "Salad", "tomato")).toBe(true);
    expect(hits("peaches", "Cobbler", "peach")).toBe(true);
    expect(hits("peas", "Fried rice", "pea")).toBe(true);
  });
  test("but not a different food that shares the letters", () => {
    expect(hits("pea", "Cobbler", "peach")).toBe(false);
    expect(hits("peas", "Cobbler", "peaches")).toBe(false);
    expect(hits("tomato paste", "Salad", "tomatoes-on-the-vine")).toBe(false);
  });
  test("nor a singular used as an attribute of something else", () => {
    expect(hits("olives", "Pasta", "olive-oil")).toBe(false);
    expect(hits("greens", "Casserole", "green-beans")).toBe(false);
    expect(hits("fries", "Chicken stir fry", "chicken")).toBe(false);
    expect(hits("olives", "Tapenade", "kalamata-olive")).toBe(true);
  });
  test("irregular endings and words that only look plural", () => {
    expect(hits("leaves", "Stock", "bay-leaf")).toBe(true);
    expect(hits("glass", "Noodle salad", "glass-noodles")).toBe(true);
    expect(hits("asparagus", "Roast", "asparagus")).toBe(true);
  });
});
