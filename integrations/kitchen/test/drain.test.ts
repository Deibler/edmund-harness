/**
 * The buttons that settle themselves have to settle CORRECTLY, exactly once.
 *
 * Every case here is a way the old "wake a model and hope" path could not fail
 * but this one can: a double tap consuming a dinner's ingredients twice, a
 * cancelled meal emptying the shelves anyway, a retry re-retracting a cleanup
 * that was already put back. Those are all silent and all destructive, so the
 * queue-marking and the fold both get round-tripped rather than eyeballed.
 *
 * Runs against a throwaway KITCHEN_DIR so it never touches a real household.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-drain-"));
const SITE = mkdtempSync(join(tmpdir(), "kitchen-site-"));
process.env.KITCHEN_DIR = BASE;
mkdirSync(join(BASE, "tenants", "t"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: {
      t: {
        name: "test",
        created: "2026-01-01T00:00:00+00:00",
        members: ["p"],
        site: { artifact: SITE, url: null },
      },
    },
  }),
);

const { append, live, openPlans } = await import("../src/store.ts");
const { drain, stillWaiting } = await import("../src/drain.ts");
const { addToList, readList } = await import("../src/list.ts");
const { loadProfiles } = await import("../src/profile.ts");
const { getAccount } = await import("../src/accounts.ts");

import { check, section } from "./harness.ts";

const CB = join(SITE, "_callbacks.jsonl");
let clock = 0;
/** Queue a tap. Timestamps must differ or the dedup key collapses two taps into one. */
function tap(o: Record<string, unknown>) {
  clock++;
  appendFileSync(
    CB,
    `${JSON.stringify({
      ts: new Date(Date.UTC(2026, 7, 16, 0, 0, clock)).toISOString(),
      profile: "p",
      ...o,
    })}\n`,
  );
}

// A stocked kitchen and two meals planned but not confirmed.
append("t", [
  {
    op: "add",
    item: "beef",
    qty: 2,
    unit: "lb",
    fields: { name: "Ground beef", cat: "meat", loc: "fridge" },
  },
  {
    op: "add",
    item: "onion",
    qty: 4,
    unit: "ct",
    fields: { name: "Onions", cat: "produce", loc: "counter" },
  },
  {
    op: "add",
    item: "milk",
    qty: 1,
    unit: "gal",
    fields: { name: "Milk", cat: "dairy", loc: "fridge" },
  },
]);
append("t", [
  {
    op: "plan",
    item: null,
    why: "beef dinner",
    src: "plan",
    plan: {
      id: "pl-made",
      meal: "beef dinner",
      created: "2026-08-16T00:00:00+00:00",
      lines: [{ item: "beef", name: "Ground beef", qty: 1 }],
    },
  },
]);
append("t", [
  {
    op: "plan",
    item: null,
    why: "onion soup",
    src: "plan",
    plan: {
      id: "pl-void",
      meal: "onion soup",
      created: "2026-08-16T00:00:00+00:00",
      lines: [{ item: "onion", name: "Onions", qty: 3 }],
    },
  },
]);

const qty = (id: string) => live("t").find((i) => i.id === id)?.qty ?? null;
check("two plans are open to start", Object.keys(openPlans("t")).length === 2);

// ── one finished meal, one called off, plus a double tap on the finished one.
tap({ kind: "plan", plan: "pl-made", name: "beef dinner", note: "made" });
tap({ kind: "plan", plan: "pl-made", name: "beef dinner", note: "made" });
tap({ kind: "plan", plan: "pl-void", name: "onion soup", note: "cancelled" });
await drain("t");

check("finishing a meal consumed its ingredients", qty("beef") === 1);
check("a double tap did not consume it twice", qty("beef") === 1);
check("calling a meal off consumed nothing", qty("onion") === 4);
check("both plans are settled", Object.keys(openPlans("t")).length === 0);

// ── starring, and a note.
tap({ kind: "favorite", recipe: "beef-dinner", on: true });
tap({ kind: "note", recipe: "beef-dinner", name: "beef dinner", text: "needs more pepper" });
await drain("t");
const prof = loadProfiles("t");
check("the star landed on the right person", (prof.favorites["beef-dinner"] ?? []).includes("p"));
check("the note was filed", (prof.notes["beef-dinner"] ?? []).length === 1);

// ── undoing an automatic cleanup, then a retry of the same tap.
const sweepBatch = append("t", [
  {
    op: "use",
    item: "milk",
    qty: null,
    fields: {},
    why: "assumed gone",
    src: "auto-cleanup",
  },
]);
check("the sweep took the milk", !live("t").some((i) => i.id === "milk"));
tap({ kind: "unsweep", batch: sweepBatch });
tap({ kind: "unsweep", batch: sweepBatch });
await drain("t");
check("undoing the cleanup put the milk back", qty("milk") === 1);
// A second retraction of the same batch is a no-op in the fold, but writing it
// would still be a lie in the log about what a person did.
const undos = live("t").length;
await drain("t");
check("a repeated unsweep changed nothing", live("t").length === undos);

// ── shopping. Ticking clears written lines and leaves stock to a receipt.
addToList("t", [
  { name: "Panko breadcrumbs", amount: "8 oz", why: "for chicken parm" },
  { name: "Heavy cream", amount: "1 pint", why: "for chicken parm" },
]);
check("two lines are on the list", readList("t").entries.length === 2);
tap({ kind: "shopped", items: ["panko-breadcrumbs"] });
await drain("t");
check("the ticked line came off the list", readList("t").entries.length === 1);
check("the untouched line stayed", readList("t").entries[0]?.name === "Heavy cream");
check("ticking invented no stock", !live("t").some((i) => i.id === "panko-breadcrumbs"));

// ── two dishes wanting the same thing is one line with two reasons.
addToList("t", [{ name: "Heavy cream", amount: "1 pint", why: "for the mushroom sauce" }]);
const cream = readList("t").entries.find((e) => e.key === "heavy-cream");
check("a duplicate merged instead of doubling", readList("t").entries.length === 1);
check(
  "and it kept both reasons",
  (cream?.why ?? "").includes("parm") && (cream?.why ?? "").includes("mushroom"),
);

// ── cooking the first half of a pair puts the leftovers in the fridge, or the
//    second half is permanently hypothetical.
process.env.KITCHEN_RECIPES = join(BASE, "recipes.json");
writeFileSync(
  join(BASE, "recipes.json"),
  JSON.stringify({
    recipes: [
      {
        id: "roast-beef",
        name: "Roast beef",
        desc: "",
        minutes: 60,
        cat: "dinner",
        needs: [["beef", 1]],
        yields: [["leftover-beef", null]],
      },
      {
        id: "beef-sandwiches",
        name: "Beef sandwiches",
        desc: "",
        minutes: 10,
        cat: "compound",
        needs: [["leftover-beef", null]],
        from: ["roast-beef"],
      },
    ],
  }),
);
append("t", [
  {
    op: "plan",
    item: null,
    why: "Roast beef",
    src: "plan",
    plan: {
      id: "pl-pair",
      meal: "Roast beef",
      created: "2026-08-16T00:00:00+00:00",
      lines: [{ item: "beef", name: "Ground beef", qty: 1 }],
    },
  },
]);
tap({ kind: "plan", plan: "pl-pair", name: "Roast beef", note: "made" });
await drain("t");
check(
  "the leftover landed in the fridge",
  live("t").some((i) => i.id === "leftover-beef"),
);
check("and it is a real container, not a level", qty("leftover-beef") === 1);

// ── declining half a pair changes nothing in the kitchen, and is reversible.
const stockBefore = live("t").length;
tap({ kind: "pairskip", recipe: "roast-beef>beef-sandwiches", note: "child" });
await drain("t");
const { loadProfiles: lp, activeSkips } = await import("../src/profile.ts");
check("the skip was recorded", activeSkips(lp("t")).has("roast-beef>beef-sandwiches|child"));
check("and consumed nothing", live("t").length === stockBefore);
tap({ kind: "pairskip", recipe: "roast-beef>beef-sandwiches", note: "undo" });
await drain("t");
check("undoing the skip clears it", activeSkips(lp("t")).size === 0);

// ── the shelf check. Confirming must WRITE, or a pass leaves the kitchen
//    looking staler than before it happened.
const { live: liveNow } = await import("../src/store.ts");
const { readLog } = await import("../src/store.ts");
tap({ kind: "reconcile", session: "rc-test", item: "onion", note: "have" });
tap({ kind: "reconcile", session: "rc-test", item: "milk", note: "amount", qty: 3, unit: "gal" });
tap({ kind: "reconcile", session: "rc-test", item: "leftover-beef", note: "gone" });
await drain("t");
const { readSessions } = await import("../src/reconcile.ts");
const sess = readSessions("t").find((x) => x.id === "rc-test")!;
check("three verdicts recorded", sess.answers.length === 3);
check(
  "each one says who looked",
  sess.answers.every((a) => a.by === "p"),
);
check("nothing reached the ledger yet", qty("milk") === 1 && !sess.applied);

tap({ kind: "reconcile", session: "rc-test", note: "apply" });
await drain("t");
check("a corrected count landed", qty("milk") === 3);
check("a gone item left the shelves", !liveNow("t").some((i) => i.id === "leftover-beef"));
// The point of a confirmation is that it WRITES. Asserting on the timestamp
// alone is not enough: nowIso is second-resolution, so a test that runs inside
// one second sees no change and passes or fails by luck.
check(
  "a confirmation wrote evidence somebody looked",
  readLog("t").some((e) => e.src === "reconcile" && e.item === "onion" && e.op === "set"),
);
check("confirming did not change the count", qty("onion") === 4);
check("the pass is marked applied", !!readSessions("t").find((x) => x.id === "rc-test")?.applied);

// Applying twice would double-write a whole pass into the ledger.
const after = liveNow("t").length;
tap({ kind: "reconcile", session: "rc-test", note: "apply" });
await drain("t");
check("re-applying a saved pass does nothing", liveNow("t").length === after && qty("milk") === 3);

// ── how the house wants to be cooked for. Deterministic, so it settles here.
section("preferences");
tap({ kind: "pref", text: "vibe", note: "allweek" });
await drain("t");
check("a vibe is pinned", getAccount("t")?.prefs?.vibe === "allweek");
tap({ kind: "pref", text: "vibe", note: null });
await drain("t");
check("and handed back to the day", getAccount("t")?.prefs?.vibe === null);
// A vibe id nobody ships must not be storable, or the site renders a mood with
// no label and the page silently loses its heading.
tap({ kind: "pref", text: "vibe", note: "nonsense" });
await drain("t");
check("an unknown vibe is refused rather than stored", getAccount("t")?.prefs?.vibe === null);

tap({
  kind: "pref",
  text: "settings",
  note: "prep",
  items: ["grill", "wrong"],
  qty: 180,
  amount: 12,
});
await drain("t");
const p = getAccount("t")!;
check("the mode is set", p.prefs?.mode === "prep");
check("the weekly budget is set", p.budget === 180);
check("the per-dinner ceiling is set", p.prefs?.per_meal === 12);
check(
  "a method that does not exist is dropped",
  JSON.stringify(p.prefs?.avoid_methods) === JSON.stringify(["grill"]),
);
// Zero has to mean "no opinion", not "this house spends nothing on food",
// because the stepper's floor is zero and that is how somebody clears it.
tap({ kind: "pref", text: "settings", note: "normal", items: [], qty: 0, amount: 0 });
await drain("t");
check("zero clears the budget rather than storing zero", getAccount("t")?.budget === null);
check("and clears the ceiling", getAccount("t")?.prefs?.per_meal === null);

// ── shopping for a dish the house has never owned anything for.
section("explore ideas");
writeFileSync(
  join(BASE, "tenants", "t", "explore.json"),
  JSON.stringify({
    generated: "2026-08-16T00:00:00.000Z",
    theme: null,
    dishes: [
      {
        id: "tagine",
        name: "Lamb tagine",
        desc: "",
        cuisine: "moroccan",
        why: "",
        buy: ["Ground lamb", "Dried apricots"],
        have: ["Yellow onions"],
        minutes: 200,
        effort: "allday",
        method: "crockpot",
        spend: 2,
        health: 3,
      },
    ],
  }),
);
tap({ kind: "idealist", recipe: "tagine", name: "Lamb tagine" });
await drain("t");
const ideaLines = readList("t").entries.filter((e) => e.why === "to try Lamb tagine");
check("the shopping landed", ideaLines.length === 2);
// No ledger slug on purpose. Claiming one would invent an inventory row for
// food the house has never bought.
check(
  "and claims no ledger identity",
  ideaLines.every((e) => e.item === null),
);
check(
  "what they already own stayed off the list",
  !readList("t").entries.some((e) => e.name === "Yellow onions"),
);

tap({ kind: "idealist", recipe: "vanished", name: "Gone" });
const goneRes = await drain("t");
check(
  "an idea that is no longer on the page says so rather than throwing",
  goneRes.done.some((l) => l.includes("no longer on the explore page")),
);

// ── anything that needs writing is left alone, not silently swallowed.
tap({ kind: "make", recipe: "beef-dinner", name: "beef dinner", users: ["p"] });
tap({ kind: "chat", text: "what can I do with the onions" });
const res = await drain("t");
check("writing work is left in the queue", res.left.length === 2);
check("and is still reported as waiting", stillWaiting("t").length === 2);
check("nothing it left was marked done", res.done.length === 0);

/* ── a replayed "we cooked it" ───────────────────────────────────────────── */

// The minute pass marks a tap served AFTER acting on it. A crash in that window
// leaves the tap in the queue, so the next pass sees it again. Every other
// auto-handled kind is naturally idempotent; this one takes food off shelves,
// so it has to recognise its own second run. The crash is simulated by clearing
// the served marker, which is exactly the state a crash would leave behind.
section("a cooked tap that gets replayed");

append("t", [
  {
    op: "add",
    item: "rice",
    qty: 6,
    unit: "cup",
    fields: { name: "Rice", cat: "pantry", loc: "pantry" },
  },
]);
writeFileSync(
  join(BASE, "tenants", "t", "recipes.json"),
  JSON.stringify({
    recipes: [
      {
        id: "rice-bowl",
        name: "Rice bowl",
        desc: "",
        minutes: 20,
        cat: "dinner",
        needs: [["rice", 2]],
      },
    ],
  }),
);

const riceBefore = live("t").find((i) => i.id === "rice")?.qty ?? 0;
tap({ kind: "cooked", recipe: "rice-bowl" });
await drain("t");
const riceAfter = live("t").find((i) => i.id === "rice")?.qty ?? 0;
check("cooking from the recipe page took the rice off", riceBefore - riceAfter === 2);

// Exactly the state a crash between acting and marking leaves behind.
writeFileSync(join(BASE, "tenants", "t", "cookbook", "_handled.json"), "[]");
const replay = await drain("t");
const riceReplayed = live("t").find((i) => i.id === "rice")?.qty ?? 0;
check("a replay after a crash does not take it off twice", riceReplayed === riceAfter);
check(
  "and the replay says so rather than staying silent",
  replay.done.some((l) => l.includes("already taken off the shelves")),
);

/* ── "make this" for a dish that is already written out ──────────────────── */

// The brief was always "write the recipe page, or if it exists send it". Only
// the first half was built, so every tap woke a session which then discovered
// the page already there. Routing is asserted rather than delivery: whether the
// text lands is the messaging layer's problem, but a make request for a written
// dish must stop being reported as work waiting for a person.
section("make, once the recipe exists");

const bookDir = join(BASE, "tenants", "t", "cookbook");
mkdirSync(bookDir, { recursive: true });
mkdirSync(join(SITE, "recipe"), { recursive: true });

tap({ kind: "make", recipe: "rice-bowl", name: "Rice bowl", users: ["p"] });
check(
  "with nothing written, it waits for a person",
  stillWaiting("t").some((r) => r.kind === "make" && r.recipe === "rice-bowl"),
);

writeFileSync(
  join(bookDir, "rice-bowl.json"),
  JSON.stringify({
    id: "rice-bowl",
    name: "Rice bowl",
    desc: "",
    minutes: 20,
    ingredients: [{ name: "Rice", amount: "2 cups" }],
    steps: [],
  }),
);
writeFileSync(join(SITE, "recipe", "rice-bowl.html"), "<html></html>");
check(
  "once it is written and on disk, nobody needs to be woken",
  !stillWaiting("t").some((r) => r.kind === "make" && r.recipe === "rice-bowl"),
);

/* ── the file the alarm reads ────────────────────────────────────────────── */

// The alarm used to watch the raw callback log, which lists every tap including
// the ones this module answers in ten seconds. It fired on work already done,
// and acting on such a wake-up sends somebody the same recipe twice. So the
// contract asserted here is narrow and load-bearing: what is published is
// exactly what stillWaiting says, and the stamp moves on every pass.
section("published queue");

const { publishQueue } = await import("../src/drain.ts");
const QUEUE = join(SITE, "pending.json");

publishQueue("t");
const q1 = JSON.parse(readFileSync(QUEUE, "utf8"));
check("it publishes for the account it was asked about", q1.account === "t");
check(
  "the written-out make is not in it, because nobody needs to write it",
  !q1.waiting.some((w: { recipe?: string }) => w.recipe === "rice-bowl"),
);
check(
  "what it lists is exactly what still waits on a person",
  q1.waiting.length === stillWaiting("t").length,
);

// A dish with no recipe on disk is real work, and must appear.
tap({ kind: "make", recipe: "never-written", name: "Never written", users: ["p"] });
publishQueue("t");
const q2 = JSON.parse(readFileSync(QUEUE, "utf8"));
check(
  "an unwritten dish shows up as waiting",
  q2.waiting.some((w: { recipe?: string }) => w.recipe === "never-written"),
);
check(
  "and carries a key the alarm can dedupe on",
  q2.waiting.every((w: { key?: string }) => typeof w.key === "string" && w.key.length > 0),
);

// The stamp is the outage alarm. If it did not move every pass, a drain that
// died at import time would look identical to a quiet kitchen.
check(
  "the stamp moves even when nothing changed",
  (() => {
    const before = JSON.parse(readFileSync(QUEUE, "utf8")).at;
    const t0 = Date.now();
    while (Date.now() === t0) {
      /* ISO stamps are millisecond resolution */
    }
    publishQueue("t");
    return JSON.parse(readFileSync(QUEUE, "utf8")).at !== before;
  })(),
);

check(
  "a failing pass says so in the file rather than serving a stale page in silence",
  (() => {
    publishQueue("t", "render: boom");
    return JSON.parse(readFileSync(QUEUE, "utf8")).trouble === "render: boom";
  })(),
);
check(
  "and a clean pass afterwards clears it",
  (() => {
    publishQueue("t");
    return JSON.parse(readFileSync(QUEUE, "utf8")).trouble === undefined;
  })(),
);

/* ── a callback cannot name a file it does not own ───────────────────────── */

// The `/upload` endpoint is careful: it rebuilds the filename from scratch and
// writes only into `img/upload/`. But `/callback` accepts any JSON object from
// anyone holding the page link, so a `photo` request can be posted directly
// with a `file` the server never wrote. This handler RENAMES that path, which
// is a read of the file and a delete of it in one move, into the directory the
// public tunnel serves. An unchecked "../.." was therefore both exfiltration of
// anything on the machine and destruction of it.
section("photo path confinement");

const outside = join(BASE, "secret.txt");
writeFileSync(outside, "an api key");
const traversalPath = relative(SITE, outside);

tap({ kind: "photo", recipe: "rice-bowl", file: traversalPath });
const traversal = await drain("t");
check(
  "the traversing request is refused, not acted on",
  traversal.done.some((l) => l.includes("refused")),
);
check(
  "and the file it named is still where it was",
  readFileSync(outside, "utf8") === "an api key",
);
check(
  "with nothing moved into the served directory",
  !existsSync(join(SITE, "img", "meals", "rice-bowl.jpg")),
);

// An absolute path is the same attack without the dots.
tap({ kind: "photo", recipe: "rice-bowl", file: outside });
check(
  "an absolute path is refused too",
  (await drain("t")).done.some((l) => l.includes("refused")),
);
check("the file survives that as well", existsSync(outside));

// A recipe id is not a path fragment either: it becomes the destination name.
mkdirSync(join(SITE, "img", "upload"), { recursive: true });
writeFileSync(join(SITE, "img", "upload", "shot.jpg"), "jpegbytes");
tap({ kind: "photo", recipe: "../../../../escaped", file: "img/upload/shot.jpg" });
check(
  "a recipe id that is really a path is refused",
  (await drain("t")).done.some((l) => l.includes("not a recipe id")),
);

// And the legitimate case still works, or the fix is just a denial of service.
tap({ kind: "photo", recipe: "rice-bowl", file: "img/upload/shot.jpg" });
const good = await drain("t");
check(
  "a real upload still becomes the picture on the card",
  existsSync(join(SITE, "img", "meals", "rice-bowl.jpg")) &&
    good.done.some((l) => l.includes("now the picture on the card")),
);

/* ── the dinner that was cooked, not the dish that shares its name ────────── */

// 2026-08-17, live, while Alex was standing at the stove. He tapped "we made
// it" at the end of a recipe I had written that morning around the raw chicken
// thighs in his fridge. The tap took a package of DELI buffalo chicken off the
// shelf instead — the meat he had told me hours earlier they were not using —
// then emptied a bottle of chipotle ranch the recipe spends a tablespoon of,
// and the whole bag of cheese it spends a fifth of.
//
// Two independent causes, and both are pinned here.
//
// The card and the written recipe share an id and disagree completely: the card
// is the general idea of a dish, the cookbook entry is the one written for this
// house on this night around what was actually in the fridge. The card was
// winning.
//
// And an open plan for the same dinner was ignored entirely, so the food came
// off once for the tap and stood ready to come off AGAIN the moment anybody
// answered the "did you make it" check-in. Consuming a meal twice is the single
// most destructive thing this module can do, which is why the plan — the only
// list a human actually agreed to, already scoped to tonight — outranks every
// reconstruction.

section("a cooked tap prefers what was actually cooked");

append("t", [
  {
    op: "add",
    item: "thighs",
    qty: 1,
    unit: "pkg",
    fields: { name: "Chicken thighs", cat: "meat", loc: "fridge" },
  },
  {
    op: "add",
    item: "deli-chicken",
    qty: 1,
    unit: "pkg",
    fields: { name: "Deli buffalo chicken", cat: "meat", loc: "fridge" },
  },
  {
    op: "add",
    item: "ranch",
    qty: 1,
    unit: "bottle",
    fields: { name: "Chipotle ranch", cat: "condiment", loc: "fridge" },
  },
]);

// Same id, two different dishes: the card built on deli meat, the page built on
// thighs. `null` on the card is "uses it up", which is what emptied the ranch.
writeFileSync(
  join(BASE, "tenants", "t", "recipes.json"),
  JSON.stringify({
    recipes: [
      {
        id: "rice-bowl",
        name: "Rice bowl",
        desc: "",
        minutes: 20,
        cat: "dinner",
        needs: [["rice", 2]],
      },
      {
        id: "wraps",
        name: "Wraps",
        desc: "",
        minutes: 30,
        cat: "dinner",
        needs: [
          ["deli-chicken", null],
          ["ranch", null],
        ],
      },
    ],
  }),
);
writeFileSync(
  join(BASE, "tenants", "t", "cookbook", "wraps.json"),
  JSON.stringify({
    id: "wraps",
    base: null,
    name: "Wraps",
    desc: "",
    minutes: 30,
    serves: 2,
    cat: "dinner",
    built: "2026-08-17T00:00:00.000Z",
    needs: [
      ["thighs", 0.5],
      ["ranch", 0.1],
    ],
    ingredients: [],
    steps: [],
  }),
);

tap({ kind: "cooked", recipe: "wraps", name: "Wraps" });
await drain("t");

check("the written recipe is what comes off the shelves", qty("thighs") === 0.5);
check("not the catalog card that happens to share its id", qty("deli-chicken") === 1);
check("and a splash of something is not the whole bottle", qty("ranch") === 0.9);

// Now the same tap with a plan already open for that dinner. The plan is scoped
// to tonight and its numbers are the agreed ones, so they win outright.
append("t", [
  { op: "add", item: "thighs", qty: 0.5, unit: "pkg", fields: { name: "Chicken thighs" } },
  {
    op: "plan",
    item: null,
    why: "Wraps",
    src: "plan",
    plan: {
      id: "pl-wraps",
      meal: "Wraps",
      created: "2026-08-17T00:00:00+00:00",
      lines: [{ item: "thighs", name: "Chicken thighs", qty: 0.25 }],
    },
  },
]);

const ranchBefore = qty("ranch");
tap({ kind: "cooked", recipe: "wraps", name: "Wraps" });
const withPlan = await drain("t");

check("an open plan for the dish is what gets confirmed", qty("thighs") === 0.75);
check("so the same dinner cannot come off the shelves twice", qty("ranch") === ranchBefore);
check(
  "and the plan is closed rather than left armed",
  !Object.keys(openPlans("t")).includes("pl-wraps"),
);
check(
  "the report says which meal settled",
  withPlan.done.some((l) => l.includes("Wraps") && l.includes("consumed")),
);

// The same button, pressed twice, because the page gives no receipt the first
// time. Two genuine taps carry two different request keys, so the replay stamp
// above cannot see them, and the first tap has already closed the plan — so
// nothing was left to stop the second deducting a whole second dinner.
section("the button pressed twice");

const thighsAfterFirst = qty("thighs");
tap({ kind: "cooked", recipe: "wraps", name: "Wraps" });
const twice = await drain("t");

check(
  "a second genuine tap takes nothing else off the shelves",
  qty("thighs") === thighsAfterFirst,
);
check(
  "and says so rather than silently doing nothing",
  twice.done.some((l) => l.includes("already came off the shelves")),
);
