/**
 * Inventory reasoning: evidence, verdicts, follow-ups and the staples rule.
 *
 * The household only sends receipts. Everything else the kitchen believes has
 * to be inferred, and every inference has to be reversible and eventually
 * confirmed. These tests pin the three promises that make that tolerable:
 * nothing is removed on the model's say-so alone, silence settles a suspicion
 * after a few days, and the list only restocks what the house has shown it
 * keeps.
 *
 * Runs against a scratch KITCHEN_DIR, with fixed clocks.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobInput } from "../../../src/cron/types.ts";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-inventory-"));
process.env.KITCHEN_DIR = BASE;
const ALEX = "imessage:dm:+15550000001";
const SAM = "imessage:dm:+15550000002";
mkdirSync(join(BASE, "tenants"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: Object.fromEntries(
      ["ev", "as", "fu", "rv", "st", "av", "sc"].map((id) => [
        id,
        {
          name: id,
          created: "2026-01-01T00:00:00+00:00",
          members: [SAM, ALEX],
          people: { [SAM]: "Sam", [ALEX]: "Alex" },
          diet: id === "av" ? { avoid: ["tomato paste"] } : undefined,
        },
      ]),
    ),
  }),
);

const { getAccount } = await import("../src/accounts.ts");
const { shelfLife, isConvenience, avoidedBy } = await import("../src/foods.ts");
const { history } = await import("../src/history.ts");
const { evidence } = await import("../src/evidence.ts");
const { applyVerdicts } = await import("../src/assess.ts");
const followups = await import("../src/followups.ts");
const { morningReview } = await import("../src/review.ts");
const { shopping } = await import("../src/shopping.ts");
const { noteLines } = await import("../src/notelist.ts");
const { menu } = await import("../src/recipes.ts");
const { saveIdeas } = await import("../src/ideas.ts");
const { followupText } = await import("../src/wake.ts");
const { append, fold, readLog } = await import("../src/store.ts");

const DAY = 86_400_000;
/** Noon local time on 2026-09-23, so hour-gated logic is deterministic. */
const NOW = new Date(2026, 8, 23, 12, 0, 0).getTime();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

type Seed = { id: string; name: string; cat: string; loc: string; qty?: number | null };
const buy = (
  acct: string,
  s: Seed,
  daysAgo: number,
  src = `receipt:shop-2026-09-0${daysAgo % 9}`,
) =>
  append(acct, [
    {
      op: "add",
      item: s.id,
      qty: s.qty === undefined ? 1 : s.qty,
      unit: "ct",
      fields: { name: s.name, cat: s.cat as never, loc: s.loc as never },
      src,
      ts: ago(daysAgo),
    },
  ]);
const cook = (acct: string, item: string, meal: string, daysAgo: number) =>
  append(acct, [
    { op: "use", item, qty: null, some: true, why: meal, src: "cooked", ts: ago(daysAgo) },
  ]);

/* ── food knowledge ───────────────────────────────────────────────────────── */

describe("shelf life", () => {
  test("pantry chicken broth does not borrow raw chicken's clock", () => {
    expect(
      shelfLife({ id: "chicken-broth", name: "Chicken broth", cat: "pantry", loc: "pantry" }),
    ).toBeNull();
  });
  test("onions on the counter keep for weeks", () => {
    expect(
      shelfLife({ id: "yellow-onions", name: "Yellow onions", cat: "produce", loc: "counter" })
        ?.life,
    ).toEqual({ low: 21, high: 60 });
  });
  test("raw chicken in the fridge may have been frozen", () => {
    expect(
      shelfLife({ id: "chicken-breasts", name: "Chicken breasts", cat: "meat", loc: "fridge" })
        ?.mayBeFrozen,
    ).toBe(true);
  });
  test("deli meat and bread are lunch food, chicken is not", () => {
    expect(isConvenience({ id: "deli-honey-ham", name: "Deli honey ham", cat: "meat" })).toBe(true);
    expect(
      isConvenience({ id: "honey-wheat-bread", name: "Honey wheat bread", cat: "bakery" }),
    ).toBe(true);
    expect(isConvenience({ id: "chicken-breasts", name: "Chicken breasts", cat: "meat" })).toBe(
      false,
    );
  });
  test("an avoid term matches the ingredient by whole words", () => {
    expect(avoidedBy(["tomato paste"], { name: "Marinara", needs: [["tomato-paste", null]] })).toBe(
      "tomato paste",
    );
    expect(
      avoidedBy(["tomato paste"], { name: "Salad", needs: [["tomatoes-on-the-vine", null]] }),
    ).toBeNull();
  });
});

/* ── history ──────────────────────────────────────────────────────────────── */

describe("history", () => {
  test("a corrected re-import of a receipt is the same trip", () => {
    const h = history([
      { ts: ago(3), batch: "a", op: "add", item: "milk", src: "receipt:costco-2026-09-20" },
      {
        ts: ago(3),
        batch: "b",
        op: "add",
        item: "milk",
        src: "receipt:costco-2026-09-20-corrected",
      },
    ]);
    expect(h.items.get("milk")?.trips).toBe(1);
    expect(h.trips).toBe(1);
  });
  test("a person saying so counts as seeing it; a price backfill does not", () => {
    const h = history([
      { ts: ago(5), batch: "a", op: "set", item: "eggs", src: "sam" },
      { ts: ago(1), batch: "b", op: "set", item: "eggs", src: "backfill:giant-prices" },
    ]);
    expect(h.items.get("eggs")?.lastSeen).toBe(ago(5));
  });
  test("an undone 'we made it' or 'we didn't' leaves the meal unconfirmed", () => {
    const plan = (id: string, meal: string) => ({
      ts: ago(3),
      batch: `plan-${id}`,
      op: "plan" as const,
      item: null,
      plan: {
        id,
        meal,
        lines: [{ item: "tortillas", name: "Tortillas", qty: null }],
        created: ago(3),
      },
    });
    const h = history([
      { ts: ago(5), batch: "buy", op: "add", item: "tortillas", src: "receipt:shop-2026-09-18" },
      plan("p1", "Tacos"),
      plan("p2", "Quesadillas"),
      { ts: ago(2), batch: "made", op: "plan_done", item: null, plan_id: "p1" },
      { ts: ago(2), batch: "void", op: "plan_void", item: null, plan_id: "p2" },
      { ts: ago(1), batch: "u1", op: "undo", batch_target: "made" },
      { ts: ago(1), batch: "u2", op: "undo", batch_target: "void" },
    ]);
    expect(h.items.get("tortillas")?.plannedSinceBought).toEqual([
      { meal: "Tacos", at: ago(3), status: "open" },
      { meal: "Quesadillas", at: ago(3), status: "open" },
    ]);
  });
});

/* ── evidence ─────────────────────────────────────────────────────────────── */

describe("evidence", () => {
  const A = "ev";
  buy(A, { id: "red-onion", name: "Red onion", cat: "produce", loc: "counter" }, 25);
  buy(A, { id: "green-grapes", name: "Green grapes", cat: "produce", loc: "fridge" }, 20);
  buy(A, { id: "chicken-breasts", name: "Chicken breasts", cat: "meat", loc: "fridge" }, 8);
  buy(A, { id: "paprika", name: "Paprika", cat: "spice", loc: "spice rack", qty: null }, 40);
  buy(A, { id: "flour", name: "Flour", cat: "pantry", loc: "pantry", qty: null }, 30);
  for (let i = 0; i < 3; i++) cook(A, "paprika", `dinner ${i}`, 20 - i);
  for (let i = 0; i < 4; i++) cook(A, "flour", `bake ${i}`, 20 - i);
  buy(A, { id: "milk", name: "Milk", cat: "dairy", loc: "fridge" }, 1);

  const est = () => Object.fromEntries(evidence(A, { now: NOW }).map((e) => [e.item.id, e]));

  test("onions near the end of their range are unsure, not gone", () => {
    expect(est()["red-onion"]?.estimate).toBe("unsure");
  });
  test("grapes twice past their life are doubtful", () => {
    expect(est()["green-grapes"]?.estimate).toBe("doubtful");
  });
  test("raw chicken past fridge life is unsure and says why", () => {
    const e = est()["chicken-breasts"]!;
    expect(e.estimate).toBe("unsure");
    expect(e.reasons.join(" ")).toContain("frozen, cooked or tossed");
  });
  test("a spice used three times is still likely there", () => {
    expect(est().paprika?.estimate).toBe("likely");
  });
  test("a pantry staple cooked with four times is probably used up", () => {
    const e = est().flour!;
    expect(e.estimate).toBe("doubtful");
    expect(e.reasons[0]).toContain("used up");
  });
  test("something bought yesterday is fresh", () => {
    expect(est().milk?.estimate).toBe("fresh");
  });
});

/* ── verdicts ─────────────────────────────────────────────────────────────── */

describe("verdicts", () => {
  const A = "as";
  buy(A, { id: "zucchini", name: "Zucchini", cat: "produce", loc: "fridge" }, 12);
  buy(A, { id: "chicken-thighs", name: "Chicken thighs", cat: "meat", loc: "fridge" }, 9);
  buy(A, { id: "scallions", name: "Scallions", cat: "produce", loc: "fridge" }, 12);

  test("a reasoned 'gone' is held as a suspicion and writes nothing", () => {
    const before = readLog(A).length;
    applyVerdicts(A, [{ item: "zucchini", verdict: "gone", reason: "12 days old" }], {
      told: false,
      now: NOW,
    });
    expect(readLog(A).length).toBe(before);
    expect(fold(A).zucchini?.gone).toBe(false);
    expect(followups.readFollowups(A).suspects.zucchini?.verdict).toBe("gone");
  });
  test("a reasoned 'frozen' moves the item", () => {
    applyVerdicts(A, [{ item: "chicken-thighs", verdict: "frozen" }], { told: false, now: NOW });
    expect(fold(A)["chicken-thighs"]?.loc).toBe("freezer");
  });
  test("a person saying it is gone is written at once and settles the suspicion", () => {
    applyVerdicts(A, [{ item: "Zucchini", verdict: "gone" }], { told: true, now: NOW });
    expect(fold(A).zucchini?.gone).toBe(true);
    expect(followups.readFollowups(A).suspects.zucchini).toBeUndefined();
  });
  test("a person saying they still have something brings it back", () => {
    applyVerdicts(A, [{ item: "zucchini", verdict: "here" }], { told: true, now: NOW });
    expect(fold(A).zucchini?.gone).toBe(false);
  });
  test("a name that matches nothing is refused, not guessed", () => {
    const r = applyVerdicts(A, [{ item: "dragonfruit", verdict: "gone" }], {
      told: true,
      now: NOW,
    });
    expect(r.said).toHaveLength(0);
    expect(r.refused[0]).toContain("dragonfruit");
  });
});

/* ── follow-ups ───────────────────────────────────────────────────────────── */

describe("follow-ups", () => {
  const A = "fu";
  buy(A, { id: "rice", name: "Rice", cat: "pantry", loc: "pantry" }, 10);
  // Bought on two trips, so the house keeps it and an assumed run-out is listed.
  buy(
    A,
    { id: "cilantro", name: "Cilantro", cat: "produce", loc: "fridge" },
    30,
    "receipt:shop-2026-08-24",
  );
  buy(A, { id: "cilantro", name: "Cilantro", cat: "produce", loc: "fridge" }, 10);
  buy(A, { id: "limes", name: "Limes", cat: "produce", loc: "fridge" }, 10);
  append(A, [
    {
      op: "plan",
      item: null,
      plan: {
        id: "p1",
        meal: "Chicken burrito bowls",
        lines: [{ item: "rice", name: "Rice", qty: null }],
        created: ago(1),
        by: ALEX,
      },
      src: "plan",
      ts: ago(1),
    },
  ]);
  followups.suspect(
    A,
    [{ id: "cilantro", name: "Cilantro", verdict: "gone", reason: "10 days in the fridge" }],
    NOW - DAY,
  );

  test("nothing is sent at night", () => {
    expect(followups.followupDue(A, new Date(2026, 8, 23, 22, 0))).toBeNull();
  });
  test("a meal sent yesterday is followed up in the afternoon, with the suspicions", () => {
    const due = followups.followupDue(A, new Date(NOW));
    expect(due?.plan.id).toBe("p1");
    expect(due?.suspects.map((s) => s.id)).toEqual(["cilantro"]);
  });
  test("the follow-up is a short text to the person the meal was for", () => {
    const due = followups.followupDue(A, new Date(NOW))!;
    const body = followupText(getAccount(A)!, due, ["Sour cream"], ALEX);
    expect(body).toContain("Follow up with Alex");
    expect(body).toContain('kitchen_plan_resolve plan:"p1"');
    expect(body).toContain("Sour cream");
    expect(body).not.toContain("KEEP_QUIET");
  });
  test("once asked, the same meal is not followed up again", () => {
    followups.markAsked(A, { plan: "p1", suspects: ["cilantro"], offered: ["sour-cream"] }, NOW);
    expect(followups.followupDue(A, new Date(NOW + 60_000))).toBeNull();
    expect(followups.mayOffer(followups.readFollowups(A), "sour-cream", NOW + DAY)).toBe(false);
  });
  test("an unanswered suspicion is assumed after two days and lands on the list", () => {
    expect(followups.settleSuspects(A, NOW + DAY).assumed).toHaveLength(0);
    const settled = followups.settleSuspects(A, NOW + 2 * DAY + 1);
    expect(settled.assumed.map((a) => a.id)).toEqual(["cilantro"]);
    expect(fold(A).cilantro?.gone).toBe(true);
    const group = shopping(A).groups.find((g) => g.id === "assumed");
    expect(group?.title).toBe("Assumed to be low/out:");
    expect(group?.lines.map((l) => l.item)).toEqual(["cilantro"]);
  });
  test("the note carries the assumed section", () => {
    expect(
      noteLines(A).some((l) => l.kind === "heading" && l.text === "Assumed to be low/out:"),
    ).toBe(true);
  });
  test("a suspicion never asked about is assumed after four days", () => {
    followups.suspect(A, [{ id: "limes", name: "Limes", verdict: "low", reason: "10 days" }], NOW);
    expect(followups.settleSuspects(A, NOW + 3 * DAY).assumed).toHaveLength(0);
    expect(followups.settleSuspects(A, NOW + 4 * DAY).assumed.map((a) => a.id)).toEqual(["limes"]);
    expect(fold(A).limes?.level).toBe("low");
  });
  test("buying the item again withdraws the suspicion instead", () => {
    followups.suspect(A, [{ id: "rice", name: "Rice", verdict: "gone", reason: "x" }], NOW);
    buy(
      A,
      { id: "rice", name: "Rice", cat: "pantry", loc: "pantry" },
      -1,
      "receipt:shop-2026-09-24",
    );
    const s = followups.settleSuspects(A, NOW + 5 * DAY);
    expect(s.dropped).toContain("rice");
    expect(s.assumed.map((a) => a.id)).not.toContain("rice");
  });
});

/* ── the morning review ───────────────────────────────────────────────────── */

describe("morning review", () => {
  const A = "rv";
  buy(A, { id: "kiwi", name: "Kiwi", cat: "produce", loc: "fridge" }, 25);
  buy(A, { id: "zucchini", name: "Zucchini", cat: "produce", loc: "fridge" }, 11);

  test("wakes the household once, with the evidence, and holds the certain ones", () => {
    const jobs: JobInput[] = [];
    const create = (i: JobInput) => {
      jobs.push(i);
      return { id: `j${jobs.length}` };
    };
    const r = morningReview(A, getAccount(A)!, { now: NOW, create });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.sessionKey).toBe(SAM);
    expect(jobs[0]!.systemEvent).toContain("Kiwi [kiwi, fridge]");
    expect(jobs[0]!.systemEvent).toContain("KEEP_QUIET");
    expect(r.held).toEqual(["kiwi"]);
    expect(followups.readFollowups(A).suspects.kiwi).toBeDefined();
  });
  test("the same items are not put in front of the model the next morning", () => {
    const jobs: JobInput[] = [];
    const create = (i: JobInput) => {
      jobs.push(i);
      return { id: `j${jobs.length}` };
    };
    const r = morningReview(A, getAccount(A)!, { now: NOW + DAY, create });
    expect(r.reviewed).toEqual([]);
    expect(jobs).toHaveLength(0);
  });
});

/* ── the staples rule, end to end ─────────────────────────────────────────── */

describe("the list only restocks what the house keeps", () => {
  const A = "st";
  buy(A, { id: "milk", name: "Milk", cat: "dairy", loc: "fridge" }, 20, "receipt:giant-2026-09-03");
  buy(A, { id: "milk", name: "Milk", cat: "dairy", loc: "fridge" }, 10, "receipt:giant-2026-09-13");
  buy(
    A,
    { id: "star-fruit", name: "Star fruit", cat: "produce", loc: "counter" },
    10,
    "receipt:giant-2026-09-13",
  );
  buy(
    A,
    { id: "tahini", name: "Tahini", cat: "pantry", loc: "pantry" },
    10,
    "receipt:giant-2026-09-13",
  );
  cook(A, "tahini", "hummus", 5);
  append(A, [
    { op: "use", item: "milk", qty: null, why: "finished" },
    { op: "use", item: "star-fruit", qty: null, why: "finished" },
    { op: "use", item: "tahini", qty: null, why: "finished" },
  ]);
  const s = shopping(A);

  test("milk, bought on two trips, goes back on the list", () => {
    expect(s.lines.map((l) => l.item)).toContain("milk");
  });
  test("tahini, bought once and cooked with, is offered, not listed", () => {
    expect(s.lines.map((l) => l.item)).not.toContain("tahini");
    expect(s.suggestions.map((x) => x.item)).toContain("tahini");
  });
  test("star fruit, bought once and never cooked with, is dropped quietly", () => {
    expect(s.lines.map((l) => l.item)).not.toContain("star-fruit");
    expect(s.suggestions.map((x) => x.item)).not.toContain("star-fruit");
    expect(s.held.some((h) => h.name === "Star fruit")).toBe(true);
  });
});

/* ── avoided food ─────────────────────────────────────────────────────────── */

describe("the avoid list is a filter", () => {
  const A = "av";
  buy(A, { id: "tomato-paste", name: "Tomato paste", cat: "pantry", loc: "pantry" }, 3);
  buy(A, { id: "deli-honey-ham", name: "Deli honey ham", cat: "meat", loc: "fridge" }, 1);
  buy(A, { id: "chicken-thighs", name: "Chicken thighs", cat: "meat", loc: "fridge" }, 1);

  test("an avoided dish is never offered", () => {
    writeFileSync(
      join(BASE, "tenants", A, "recipes.json"),
      JSON.stringify({
        recipes: [
          {
            id: "marinara",
            name: "Marinara",
            desc: "",
            cat: "dinner",
            minutes: 20,
            needs: [["tomato-paste", null]],
          },
        ],
      }),
    );
    expect(menu(A).map((r) => r.id)).not.toContain("marinara");
  });
  test("saving ideas refuses avoided food and deli-anchored dinners, and allows basics", () => {
    const res = saveIdeas(A, [
      {
        id: "paste-pasta",
        name: "Paste pasta",
        minutes: 20,
        cat: "dinner",
        needs: [["tomato-paste", null]],
      },
      {
        id: "ham-dinner",
        name: "Ham dinner",
        minutes: 20,
        cat: "dinner",
        needs: [["deli-honey-ham", null]],
      },
      {
        id: "thighs",
        name: "Salted thighs",
        minutes: 30,
        cat: "dinner",
        needs: [
          ["chicken-thighs", null],
          ["salt", null],
        ],
      },
    ]);
    expect(res.saved.map((r) => r.id)).toEqual(["thighs"]);
    expect(res.rejected.map((r) => r.id).sort()).toEqual(["ham-dinner", "paste-pasta"]);
  });
});

/* ── fixes found in review ────────────────────────────────────────────────── */

describe("edge cases", () => {
  test("editing a schedule from chat keeps what it recently suggested", async () => {
    const { updateAccount } = await import("../src/accounts.ts");
    const { kitchenTools } = await import("../tools.ts");
    updateAccount("sc", {
      dinners: [
        {
          id: "d1",
          at: "16:00",
          days: [],
          to: [],
          meal: "dinner",
          on: true,
          created: ago(10),
          picks: [{ day: "2026-09-22", recipe: "tilapia-lemon-pepper" }],
        },
      ],
    });
    const tool = kitchenTools({
      sessionKey: SAM,
      config: { kitchen: { enabled: true, dir: BASE }, paths: { data_dir: BASE } },
    } as never).find((t) => t.name === "kitchen_schedule")!;
    await tool.handler({ account: "sc", action: "set", id: "d1", at: "17:00" } as never);
    const d = getAccount("sc")!.dinners![0]!;
    expect(d.at).toBe("17:00");
    expect(d.picks).toEqual([{ day: "2026-09-22", recipe: "tilapia-lemon-pepper" }]);
  });

  test("the page a dinner text asks for is written quietly, not a second text", async () => {
    const { wakeForRequests } = await import("../src/wake.ts");
    const jobs: JobInput[] = [];
    const create = (i: JobInput) => {
      jobs.push(i);
      return { id: `j${jobs.length}` };
    };
    wakeForRequests(
      "sc",
      getAccount("sc")!,
      [
        {
          kind: "make",
          recipe: "tilapia-lemon-pepper",
          name: "Tilapia",
          note: "scheduled",
          profile: null,
          users: [SAM],
          ts: ago(0),
          client_ts: ago(0),
        },
      ],
      { create, now: NOW },
    );
    expect(jobs[0]!.systemEvent).toContain("KEEP_QUIET");
    expect(jobs[0]!.systemEvent).toContain("text the page link");
  });

  test("an undo that was itself undone does not hide a cooked meal", async () => {
    const { cookedRecently } = await import("../src/plans.ts");
    const meal = append("sc", [
      { op: "use", item: "rice", qty: null, some: true, why: "Fried rice", src: "cooked" },
    ]);
    const undo = append("sc", [{ op: "undo", batch_target: meal }]);
    expect(cookedRecently("sc", "Fried rice")).toBeNull();
    append("sc", [{ op: "undo", batch_target: undo }]);
    expect(cookedRecently("sc", "Fried rice")).not.toBeNull();
  });
});
