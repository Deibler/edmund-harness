/**
 * A dish authored as lunch is lunch.
 *
 * 2026-08-27. The 4pm text offered "Ham and Swiss Sandwiches with Green Beans"
 * as dinner. The catalog was right — that recipe is filed `cat: "lunch"` — and
 * the picker was wrong: `CATS_FOR.dinner` reused `MEAL_CATS`, which exists to
 * answer a DIFFERENT question ("is this a meal rather than a side or a
 * dessert") and therefore includes lunch. Sharing the set let a fifteen-minute
 * sandwich that was fully in stock and had never been cooked outscore every
 * real dinner in the house, because `novelty` pays for never-made and nothing
 * in the score knew what meal it was answering.
 *
 * The asymmetry is the part worth protecting: a dinner may be lunch, a lunch
 * may not be dinner. It reads like a symmetric relation and it is not, so the
 * test states both directions rather than just the one that broke.
 *
 * Runs against a scratch KITCHEN_DIR — never the real one.
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

// Both dishes need exactly the same two things, so stock can never be the
// reason one wins. The only difference the picker can see is `cat` — and, in
// the sandwich's favour, that it is faster and has never been made.
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
          ["test-bread", null],
          ["test-deli", null],
        ],
      },
      {
        id: "test-skillet",
        name: "Test Skillet",
        desc: "",
        cat: "dinner",
        minutes: 45,
        needs: [
          ["test-bread", null],
          ["test-deli", null],
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
    item: "test-bread",
    qty: 1,
    unit: "ct",
    fields: { name: "Test bread", cat: "pantry", loc: "pantry" },
  },
  {
    op: "add",
    item: "test-deli",
    qty: 1,
    unit: "pkg",
    fields: { name: "Test deli", cat: "meat", loc: "fridge" },
  },
]);

/* ── the bug ──────────────────────────────────────────────────────────────── */

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
