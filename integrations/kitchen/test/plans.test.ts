/**
 * The one path that takes food off the shelves.
 *
 * Everything here is a way a household loses food it still has, or keeps food
 * it has eaten, and none of it is visible until somebody opens the fridge and
 * finds the ledger lying. The three defects pinned below all shipped, and all
 * three came from the same root: three surfaces asserting one fact about one
 * dinner, each with its own copy of the arithmetic.
 *
 * Runs against a scratch KITCHEN_DIR — never the real one.
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

// `fold`, not `live` — live() drops anything marked gone, which is precisely
// the state half of these assertions are about.
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

// 2026-08-17. A recipe card listed `["ranch", null]`, meaning "a wrap uses
// ranch, nobody wrote down how much". The fold read that null the way a PERSON
// means it — "we finished the ranch" — and emptied a full bottle for a dish
// that spends a tablespoon. Same for the cheese. The two meanings have to be
// told apart at the write, because by the time the fold sees them the events
// are identical.

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

// The other half. A human saying "we used it up" still has to mean exactly that,
// or there is no way left to say it.
append("t", [
  { op: "use", item: "oil", qty: null, fields: {}, why: "finished it", src: "kitchen_record" },
]);
check("a person can still say a bottle is finished", gone("oil"));

// A counted item is unchanged: one cucumber, used, is no cucumbers. That
// reading was always right and must not be softened along with the rest.
append("t", useLines("t", [{ item: "cucumber", qty: null }], "Salad"));
check("using the cucumber still finishes the cucumber", gone("cucumber"));

/* ── the leftovers a confirmed meal leaves behind ─────────────────────────── */

// `kitchen_plan_resolve` had its own copy of this and had already drifted: it
// wrote the consumption but never the leftovers, so a batch cook confirmed from
// a chat lost its second night while the same meal confirmed from the site kept
// it. Nobody would notice until the site offered "fried rice from last night"
// and then insisted there was no rice.

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

// The button gives no receipt on the page, so pressing it again is the normal
// human response to "did that work?". Two genuine taps carry two different
// request keys, so the replay stamp cannot see them, and once the first tap has
// closed the plan there is nothing open left to protect the second.

section("a dish tapped twice");

check("the meal just cooked reads as recently cooked", !!cookedRecently("t", "Big batch"));
check("a dish nobody cooked does not", cookedRecently("t", "Something else") === null);

// Six hours on, the same dish is a genuinely new dinner rather than a stray tap.
const stale = Date.now() + 7 * 60 * 60 * 1000;
check("and the guard lets go after the window", cookedRecently("t", "Big batch", stale) === null);

/* ── retracting a meal really retracts it ─────────────────────────────────── */

// An undone batch must stop counting as evidence the dish was cooked, or a
// correction leaves the house unable to log the meal it actually ate.

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

// Two open plans for one dish is a real state: a plan gets re-scoped during the
// afternoon, or an undo restores an older one. Whichever the object yielded
// first used to win, so which quantities came off the shelves depended on
// insertion order.
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
