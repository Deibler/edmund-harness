/**
 * Pantry basics: one definition for saving, cooking and pruning.
 *
 * Ideas may name salt and pepper without the ledger tracking them, and the
 * brief says so. If cooking then counted them as missing, every seasoned idea
 * would read "Short 2" and be deleted by the next morning's prune. These pin
 * that saving, cookability, pruning and the recipe page agree, and that a basic
 * the household does track is judged by its tracked state.
 *
 * Runs against a scratch KITCHEN_DIR and an empty catalog.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-basics-"));
process.env.KITCHEN_DIR = BASE;
process.env.KITCHEN_RECIPES = join(BASE, "catalog.json");
writeFileSync(process.env.KITCHEN_RECIPES, JSON.stringify({ recipes: [] }));
mkdirSync(join(BASE, "tenants"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: Object.fromEntries(
      ["un", "tr"].map((id) => [
        id,
        {
          name: id,
          created: "2026-01-01T00:00:00+00:00",
          members: ["imessage:dm:+15550000001"],
        },
      ]),
    ),
  }),
);

const { getAccount } = await import("../src/accounts.ts");
const { saveIdeas, pruneIdeas, ideasBrief } = await import("../src/ideas.ts");
const { cookable, loadRecipes } = await import("../src/recipes.ts");
const { renderRecipePage } = await import("../src/recipepage.ts");
const { append, fold } = await import("../src/store.ts");

const thighs = (acct: string) =>
  append(acct, [
    {
      op: "add",
      item: "chicken-thighs",
      qty: 2,
      unit: "lb",
      fields: { name: "Chicken thighs", cat: "meat", loc: "fridge" },
      src: "receipt:shop-2026-09-20",
    },
  ]);
const salted = {
  id: "salted-thighs",
  name: "Salted thighs",
  minutes: 30,
  cat: "dinner",
  needs: [
    ["chicken-thighs", null],
    ["salt", null],
    ["black-pepper", null],
  ],
};
const scored = (acct: string) =>
  cookable(fold(acct), loadRecipes(acct).recipes).find((c) => c.recipe.id === "salted-thighs")!;

describe("untracked basics are in every kitchen", () => {
  const A = "un";
  thighs(A);

  test("saving accepts an idea seasoned with salt and pepper", () => {
    expect(saveIdeas(A, [salted]).saved.map((r) => r.id)).toEqual(["salted-thighs"]);
  });
  test("and it is ready to cook, missing nothing", () => {
    const c = scored(A);
    expect(c.missing.map((m) => m.id)).toEqual([]);
    expect(c.ready).toBe(true);
  });
  test("the morning prune keeps it", () => {
    const res = pruneIdeas(A);
    expect(res.dropped).toEqual([]);
    expect(res.kept.map((r) => r.id)).toContain("salted-thighs");
  });
  test("the recipe page does not list salt as a shortfall or badge it out", () => {
    const html = renderRecipePage(
      {
        id: "salted-thighs",
        base: null,
        name: "Salted thighs",
        desc: "",
        minutes: 30,
        serves: 2,
        cat: "dinner",
        built: "2026-09-20T00:00:00.000Z",
        needs: salted.needs as Array<[string, number | null]>,
        ingredients: [
          { name: "Chicken thighs", amount: "2 lb", item: "chicken-thighs" },
          { name: "Salt", amount: "to taste", item: "salt" },
        ],
        steps: [{ n: 1, title: "Season", body: "Season.", uses: [] }],
      },
      { items: fold(A), prices: new Map(), title: "Test kitchen" },
    );
    expect(html).toContain("Everything this needs is in the kitchen right now.");
    expect(html).not.toContain(">out<");
  });
});

describe("a basic the household tracks is judged by the ledger", () => {
  const A = "tr";
  thighs(A);
  append(A, [
    {
      op: "add",
      item: "salt",
      qty: null,
      fields: { name: "Salt", cat: "spice", loc: "pantry", level: "full" },
      src: "receipt:shop-2026-09-20",
    },
  ]);
  saveIdeas(A, [salted]);
  // Somebody said it ran out.
  append(A, [{ op: "use", item: "salt", qty: null, why: "we're out", src: "told" }]);

  test("tracked and out, it is missing and the dish is not ready", () => {
    const c = scored(A);
    expect(c.missing.map((m) => m.id)).toEqual(["salt"]);
    expect(c.ready).toBe(false);
  });
  test("but running out of salt never deletes the idea", () => {
    expect(pruneIdeas(A).kept.map((r) => r.id)).toContain("salted-thighs");
  });
  test("and the brief stops promising salt", () => {
    const line = ideasBrief(A, getAccount(A)!, 1)
      .split("\n")
      .find((l) => l.startsWith("Always available"));
    expect(line).toContain("black-pepper");
    expect(line).not.toMatch(/\bsalt\b/);
  });
});
