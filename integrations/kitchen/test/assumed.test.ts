/**
 * "Assumed to be low/out:" obeys the same rules as the rest of the list.
 *
 * The section lists run-outs nobody confirmed. It used to be decided on its own
 * path, before any of the household's answers were read, so "I do not buy
 * this" and "not this trip" did nothing to it, one-off purchases landed on it,
 * saying "we still have it" about a low item moved it to the confirmed
 * section, and ticking a line recorded a shopping trip. Each case below is one
 * of those, driven through the real paths: the follow-up settling, the site
 * taps the drain settles, and the chat verdict.
 *
 * Runs against a scratch KITCHEN_DIR and site directory.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-assumed-"));
const SITE = mkdtempSync(join(tmpdir(), "kitchen-assumed-site-"));
process.env.KITCHEN_DIR = BASE;
process.env.KITCHEN_RECIPES = join(BASE, "catalog.json");
writeFileSync(process.env.KITCHEN_RECIPES, JSON.stringify({ recipes: [] }));
mkdirSync(join(BASE, "tenants", "h"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: {
      h: {
        name: "h",
        created: "2026-01-01T00:00:00+00:00",
        members: ["imessage:dm:+15550000001"],
        site: { artifact: SITE, url: null },
      },
    },
  }),
);

const followups = await import("../src/followups.ts");
const { applyVerdicts } = await import("../src/assess.ts");
const { drain } = await import("../src/drain.ts");
const { history } = await import("../src/history.ts");
const { shopping, tripCount } = await import("../src/shopping.ts");
const { append, fold, readLog } = await import("../src/store.ts");

const A = "h";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const TRIPS = ["receipt:giant-2026-08-20", "receipt:giant-2026-09-05"];
/** Bought on the first `n` trips; two makes it something the house keeps. */
const buy = (id: string, name: string, cat: string, n = 2) =>
  TRIPS.slice(0, n).forEach((src, i) =>
    append(A, [
      {
        op: "add",
        item: id,
        qty: 1,
        unit: "ct",
        fields: { name, cat: cat as never, loc: "pantry" },
        src,
        ts: ago(30 - 15 * i),
      },
    ]),
  );

let clock = 0;
/** Queue a site tap for the drain. Distinct timestamps keep the keys distinct. */
function tap(o: Record<string, unknown>) {
  clock++;
  appendFileSync(
    join(SITE, "_callbacks.jsonl"),
    `${JSON.stringify({ ts: new Date(Date.UTC(2026, 8, 20, 0, 0, clock)).toISOString(), profile: "p", ...o })}\n`,
  );
}

const group = (id: string) =>
  (shopping(A).groups.find((g) => g.id === id)?.lines ?? []).map((l) => l.item);
const onList = () => shopping(A).lines.map((l) => l.item);
const heldFor = (name: string) => shopping(A).held.find((h) => h.name === name)?.why;
const tripsOf = (id: string) => history(readLog(A)).items.get(id)?.trips ?? 0;

buy("rice", "Rice", "pantry");
buy("flour", "Flour", "pantry");
buy("milk", "Milk", "dairy");
buy("melon", "Melon", "produce");
buy("limes", "Limes", "produce");
buy("eggs", "Eggs", "dairy");
buy("oats", "Oats", "pantry");
buy("kiwi", "Kiwi", "produce", 1); // once, never cooked with: a one-off
append(A, [{ op: "use", item: "eggs", qty: null, why: "finished them", ts: ago(2) }]);

// Suspicions nobody was asked about, old enough to be assumed.
followups.suspect(
  A,
  [
    { id: "rice", name: "Rice", verdict: "low", reason: "two dinners since" },
    { id: "flour", name: "Flour", verdict: "low", reason: "baked twice" },
    { id: "milk", name: "Milk", verdict: "gone", reason: "two weeks old" },
    { id: "melon", name: "Melon", verdict: "gone", reason: "two weeks old" },
    { id: "limes", name: "Limes", verdict: "gone", reason: "two weeks old" },
    { id: "kiwi", name: "Kiwi", verdict: "gone", reason: "four weeks old" },
    { id: "oats", name: "Oats", verdict: "gone", reason: "used in six breakfasts" },
  ],
  Date.now() - 5 * DAY,
);
const settled = followups.settleSuspects(A, Date.now());

describe("the household's answers apply to assumed lines", () => {
  test("every suspicion was assumed", () => {
    expect(settled.assumed.map((a) => a.id).sort()).toEqual(
      ["flour", "kiwi", "limes", "melon", "milk", "oats", "rice"].sort(),
    );
  });

  test("'I do not buy this' and 'not this trip' take an assumed line off", async () => {
    tap({ kind: "keep", note: "never", id: "melon", name: "Melon" });
    tap({ kind: "keep", note: "skip", id: "limes", name: "Limes" });
    await drain(A);
    expect(group("assumed")).not.toContain("melon");
    expect(group("assumed")).not.toContain("limes");
    expect(heldFor("Melon")).toBe("you said this was a one-off");
    expect(heldFor("Limes")).toBe("not this trip");
  });

  test("a one-off purchase assumed out is dropped, as any one-off is", () => {
    expect(onList()).not.toContain("kiwi");
    expect(heldFor("Kiwi")).toBe("bought once and never cooked with");
  });

  test("a staple assumed out is still listed, under its own heading", () => {
    expect(group("assumed").sort()).toEqual(["flour", "milk", "oats", "rice"]);
    expect(group("staple")).toEqual(["eggs"]);
  });

  test("a rename or a price backfill does not turn the guess into a fact", () => {
    append(A, [
      { op: "set", item: "oats", fields: { name: "Rolled oats" }, why: "renamed" },
      { op: "set", item: "oats", fields: { price: 3.49 }, src: "backfill:giant-prices" },
    ]);
    expect(group("assumed")).toContain("oats");
    expect(group("staple")).not.toContain("oats");
  });
});

describe("'we still have it' takes an assumed line off", () => {
  test("said in chat, about something assumed low: the low is cleared", () => {
    applyVerdicts(A, [{ item: "rice", verdict: "here" }], { told: true });
    expect(fold(A).rice?.level).toBe("full");
    expect(onList()).not.toContain("rice");
  });

  test("the site's 'I already have this' does the same", async () => {
    tap({ kind: "restock", items: ["flour"] });
    const res = await drain(A);
    expect(res.done.join("\n")).toContain("corrected on the shelves: flour");
    expect(fold(A).flour?.level).toBe("full");
    expect(onList()).not.toContain("flour");
  });
});

describe("a tick on an assumed line means they still have it", () => {
  test("it goes back in the kitchen and off the list", async () => {
    const trips = tripCount(A);
    const milkTrips = tripsOf("milk");
    tap({ kind: "shopped", items: ["milk"] });
    const res = await drain(A);
    expect(res.done.join("\n")).toContain("no trip recorded");
    expect(fold(A).milk?.gone).toBe(false);
    expect(onList()).not.toContain("milk");
    // Nothing was bought: no trip for the house or for the item.
    expect(tripCount(A)).toBe(trips);
    expect(tripsOf("milk")).toBe(milkTrips);
  });

  test("so it spends nobody's 'not this trip'", () => {
    expect(heldFor("Limes")).toBe("not this trip");
  });

  test("a real purchase ticked beside it is still a trip, and ends the skip", async () => {
    const trips = tripCount(A);
    tap({ kind: "shopped", items: ["eggs"] });
    await drain(A);
    expect(tripCount(A)).toBe(trips + 1);
    expect(fold(A).eggs?.gone).toBe(false);
    expect(group("assumed")).toContain("limes");
  });
});
