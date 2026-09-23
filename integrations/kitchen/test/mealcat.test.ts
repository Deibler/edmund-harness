/**
 * Meal categories: a lunch dish is never the dinner pick, while a dinner dish
 * may still be lunch. The relation is one-way, so both directions are tested.
 * Also: a dish filed as dinner but built on deli meat is lunch food.
 *
 * Runs against a scratch KITCHEN_DIR.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-mealcat-"));
process.env.KITCHEN_DIR = BASE;
mkdirSync(join(BASE, "tenants", "t"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: { t: { name: "test", created: "2026-01-01T00:00:00+00:00", members: ["p"] } },
  }),
);

// Both dishes need the same two things, so only `cat` separates them; the
// sandwich is faster and never made, which favours it on every other term.
writeFileSync(
  join(BASE, "tenants", "t", "recipes.json"),
  JSON.stringify({
    recipes: [
      {
        id: "test-sandwich",
        name: "Test Sandwich",
        desc: "",
        cat: "lunch",
        minutes: 10,
        needs: [
          ["test-rice", null],
          ["test-chicken", null],
        ],
      },
      {
        id: "test-skillet",
        name: "Test Skillet",
        desc: "",
        cat: "dinner",
        minutes: 45,
        needs: [
          ["test-rice", null],
          ["test-chicken", null],
        ],
      },
    ],
  }),
);

const { append } = await import("../src/store.ts");
const { pickFor } = await import("../src/schedules.ts");

import type { Account } from "../src/types.ts";
import { check, section } from "./harness.ts";

const acct: Account = {
  name: "test",
  created: "2026-01-01T00:00:00+00:00",
  members: ["p"],
};

append("t", [
  {
    op: "add",
    item: "test-rice",
    qty: 1,
    unit: "ct",
    fields: { name: "Test rice", cat: "pantry", loc: "pantry" },
  },
  {
    op: "add",
    item: "test-chicken",
    qty: 1,
    unit: "pkg",
    fields: { name: "Test chicken", cat: "meat", loc: "fridge" },
  },
]);

/* ── a lunch dish is not dinner ───────────────────────────────────────────── */

section("a sandwich is not dinner");

const dinner = pickFor("t", acct, "dinner");

check("dinner is picked at all", dinner !== null);
check("and it is not the lunch dish", dinner?.recipe.id !== "test-sandwich");
check("no lunch-category dish can be offered as dinner", dinner?.recipe.cat !== "lunch");
check(
  "the faster, never-cooked sandwich loses to the real dinner anyway",
  dinner?.recipe.id === "test-skillet",
);

/* ── the direction that must still work ───────────────────────────────────── */

section("but a lunch dish is still lunch");

const lunch = pickFor("t", acct, "lunch");

check("lunch still has an answer", lunch !== null);
check("and a dish written for lunch wins it", lunch?.recipe.id === "test-sandwich");

/* ── lunch food does not anchor a dinner ──────────────────────────────────── */

section("deli meat is not the centre of a dinner");

const { writeFileSync: write } = await import("node:fs");
write(
  join(BASE, "tenants", "t", "recipes.json"),
  JSON.stringify({
    recipes: [
      {
        id: "ham-melt-dinner",
        name: "Ham Melt Dinner",
        desc: "",
        cat: "dinner",
        minutes: 15,
        needs: [["deli-honey-ham", null]],
      },
    ],
  }),
);
append("t", [
  {
    op: "add",
    item: "deli-honey-ham",
    qty: 1,
    unit: "pkg",
    fields: { name: "Deli honey ham", cat: "meat", loc: "fridge" },
  },
]);
const deliDinner = pickFor("t", acct, "dinner");
check(
  "a dinner built on deli ham is never the dinner text",
  deliDinner?.recipe.id !== "ham-melt-dinner",
);
