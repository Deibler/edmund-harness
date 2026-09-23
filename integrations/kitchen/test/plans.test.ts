/**
 * Confirming a meal: the one path that takes food off the shelves.
 *
 * The defects pinned here came from several surfaces asserting one fact about one
 * dinner, each with its own copy of the arithmetic.
 *
 * Runs against a scratch KITCHEN_DIR.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-plans-"));
process.env.KITCHEN_DIR = BASE;
mkdirSync(join(BASE, "tenants", "t"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: { t: { name: "test", created: "2026-01-01T00:00:00+00:00", members: ["p"] } },
  }),
);

const { append, fold, openPlans } = await import("../src/store.ts");
const { confirmPlan, cookedRecently, planFor, useLines } = await import("../src/plans.ts");

import { check, section } from "./harness.ts";

// `fold`, not `live`: live() drops gone items, which half of these assertions are
// about.
const item = (id: string) => fold("t")[id];
const qty = (id: string) => item(id)?.qty ?? null;
const gone = (id: string) => !!item(id)?.gone;

append("t", [
  // Counted: somebody knows how many there are.
  {
    op: "add",
    item: "thighs",
    qty: 1,
    unit: "pkg",
    fields: { name: "Chicken thighs", cat: "meat", loc: "fridge" },
  },
  {
    op: "add",
    item: "cucumber",
    qty: 1,
    unit: "ct",
    fields: { name: "Cucumber", cat: "produce", loc: "fridge" },
  },
  // Level-tracked: nobody has ever counted the bottle, so `qty` is null.
  {
    op: "add",
    item: "ranch",
    unit: "bottle",
    fields: { name: "Chipotle ranch", cat: "condiment", loc: "fridge", level: "full" },
  },
  {
    op: "add",
    item: "oil",
    unit: "bottle",
    fields: { name: "Olive oil", cat: "pantry", loc: "pantry", level: "full" },
  },
]);

check("a level-tracked staple starts uncounted", qty("ranch") === null && !gone("ranch"));

/* ── an unwritten amount is not the whole bottle ──────────────────────────── */

// A recipe line with no amount (`["ranch", null]`) means "some", not "all of it". The
// two meanings are told apart at the write, because the fold sees identical events.

section("a recipe's missing amount");

append(
  "t",
  useLines(
    "t",
    [
      { item: "ranch", qty: null },
      { item: "oil", qty: null },
    ],
    "Wraps",
  ),
);

check("a dish that uses some ranch does not empty the bottle", !gone("ranch"));
check("nor the oil", !gone("oil"));
check("and the level is left where it was, not knocked to out", item("ranch")?.level === "full");
check(
  "but the touch is recorded, so a shelf check knows to look",
  (item("ranch")?.uses_since_check ?? 0) === 1,
);

// A person saying "we used it up" still means all of it.
append("t", [
  { op: "use", item: "oil", qty: null, fields: {}, why: "finished it", src: "kitchen_record" },
]);
check("a person can still say a bottle is finished", gone("oil"));

// A counted item is unchanged: one cucumber, used, is no cucumbers.
append("t", useLines("t", [{ item: "cucumber", qty: null }], "Salad"));
check("using the cucumber still finishes the cucumber", gone("cucumber"));

/* ── the leftovers a confirmed meal leaves behind ─────────────────────────── */

// Every confirmation path must also write the leftovers, or a batch cook confirmed
// from a chat loses its second night.

section("leftovers");

writeFileSync(
  join(BASE, "tenants", "t", "recipes.json"),
  JSON.stringify({
    recipes: [
      {
        id: "big-batch",
        name: "Big batch",
        desc: "",
        minutes: 30,
        cat: "dinner",
        needs: [["thighs", 0.5]],
        yields: [["leftover-big-batch", null]],
      },
    ],
  }),
);

append("t", [
  {
    op: "plan",
    item: null,
    why: "Big batch",
    src: "plan",
    plan: {
      id: "pl-batch",
      meal: "Big batch",
      created: "2026-08-17T00:00:00+00:00",
      lines: [{ item: "thighs", name: "Chicken thighs", qty: 0.5 }],
    },
  },
]);

const done = confirmPlan("t", "pl-batch", {
  meal: "Big batch",
  lines: [{ item: "thighs", qty: 0.5 }],
});

check("confirming consumes what the plan agreed to", qty("thighs") === 0.5);
check("and puts the leftovers in the fridge", !!item("leftover-big-batch"));
check("the caller is told about both", done.items === 1 && done.yields === 1);
check("and the plan is closed", !Object.keys(openPlans("t")).includes("pl-batch"));

/* ── one dinner cannot be paid for twice ──────────────────────────────────── */

// Pressing the button again is a normal "did that work?", and two taps carry
// different request keys, so a repeat confirmation of the same dinner shortly after
// must not consume it twice.

section("a dish tapped twice");

check("the meal just cooked reads as recently cooked", !!cookedRecently("t", "Big batch"));
check("a dish nobody cooked does not", cookedRecently("t", "Something else") === null);

// Six hours on, the same dish is a genuinely new dinner rather than a stray tap.
const stale = Date.now() + 7 * 60 * 60 * 1000;
check("and the guard lets go after the window", cookedRecently("t", "Big batch", stale) === null);

/* ── retracting a meal really retracts it ─────────────────────────────────── */

// An undone batch must stop counting as evidence the dish was cooked.

section("undo");

append("t", [
  {
    op: "plan",
    item: null,
    why: "Skillet hash",
    src: "plan",
    plan: {
      id: "pl-again",
      meal: "Skillet hash",
      created: "2026-08-17T00:00:00+00:00",
      lines: [{ item: "thighs", name: "Chicken thighs", qty: 0.25 }],
    },
  },
]);
const before = qty("thighs");
const second = confirmPlan("t", "pl-again", {
  meal: "Skillet hash",
  lines: [{ item: "thighs", qty: 0.25 }],
});
check("the second confirmation consumed again", qty("thighs") === (before ?? 0) - 0.25);

append("t", [
  { op: "undo", item: null, batch_target: second.batch, why: "did not happen", src: "test" },
]);

check("undoing a confirmed meal puts the food back", qty("thighs") === before);
check(
  "and it stops counting as evidence the dish was cooked",
  cookedRecently("t", "Skillet hash") === null,
);
check(
  "so the plan is open again and can be settled properly",
  Object.keys(openPlans("t")).includes("pl-again"),
);

/* ── finding the plan a page is talking about ─────────────────────────────── */

section("matching a page to its plan");

append("t", [
  {
    op: "plan",
    item: null,
    why: "Big batch",
    src: "plan",
    plan: {
      id: "pl-match",
      meal: "Big Batch",
      created: "2026-08-17T00:00:00+00:00",
      lines: [{ item: "thighs", name: "Chicken thighs", qty: 0.1 }],
    },
  },
]);

check(
  "a recipe id finds the plan whose meal name slugs to it",
  planFor("t", "big-batch")?.id === "pl-match",
);
check("a display name works too", planFor("t", "nope", "Big Batch")?.id === "pl-match");
check("and an unrelated dish matches nothing", planFor("t", "lasagne") === null);

// Two open plans for one dish can exist (a re-scope, an undo); the choice must not
// depend on insertion order.
append("t", [
  {
    op: "plan",
    item: null,
    why: "Big batch",
    src: "plan",
    plan: {
      id: "pl-newer",
      meal: "Big batch",
      created: "2026-08-17T18:00:00+00:00",
      lines: [{ item: "thighs", name: "Chicken thighs", qty: 0.05 }],
    },
  },
]);
check(
  "with two plans for one dish, the one agreed to most recently wins",
  planFor("t", "big-batch")?.id === "pl-newer",
);
