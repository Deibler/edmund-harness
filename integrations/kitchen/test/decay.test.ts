/**
 * The leftover sweep: what it retires, and that one undo restores it all.
 *
 * Runs against a scratch KITCHEN_DIR.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-decay-"));
process.env.KITCHEN_DIR = BASE;
mkdirSync(join(BASE, "tenants", "t"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: { t: { name: "test", created: "2026-01-01T00:00:00+00:00", members: ["p"] } },
  }),
);

const { append, live } = await import("../src/store.ts");
const { staleItems, sweepStale, lastSweep } = await import("../src/decay.ts");

const DAY = 86_400_000;
const iso = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, "+00:00");

import { check } from "./harness.ts";

// Old leftovers, onions on the counter, paprika, raw meat past its date, frozen peas.
append("t", [
  {
    op: "add",
    item: "leftover-chili",
    qty: 1,
    unit: "container",
    fields: { name: "Leftover chili", cat: "other", loc: "fridge" },
    ts: iso(6 * DAY),
  },
  {
    op: "add",
    item: "yellow-onions",
    qty: 8,
    unit: "ct",
    fields: { name: "Yellow onions", cat: "produce", loc: "counter" },
    ts: iso(20 * DAY),
  },
  {
    op: "add",
    item: "paprika",
    qty: null,
    fields: { name: "Paprika", cat: "spice", loc: "spice rack", level: "full" },
    ts: iso(60 * DAY),
  },
  {
    op: "add",
    item: "chicken",
    qty: 1,
    unit: "pkg",
    fields: { name: "Chicken", cat: "meat", loc: "fridge", expires: "2000-01-01" },
    ts: iso(3 * DAY),
  },
  {
    op: "add",
    item: "frozen-peas",
    qty: 1,
    unit: "bag",
    fields: { name: "Frozen peas", cat: "frozen", loc: "freezer" },
    ts: iso(90 * DAY),
  },
]);

const stale = staleItems("t");
const ids = stale.map((s) => s.item.id).sort();
check("6-day-old leftovers are stale", ids.includes("leftover-chili"));
check(
  "raw meat past its date is not swept; it is reviewed, since it is usually frozen",
  !ids.includes("chicken"),
);
check("onions on the counter are not swept", !ids.includes("yellow-onions"));
check("a level-tracked spice is never stale", !ids.includes("paprika"));
check("frozen is never stale", !ids.includes("frozen-peas"));

const before = live("t").length;
const swept = sweepStale("t");
check("sweep removed exactly the stale ones", swept.removed.length === stale.length);
check("one batch for the whole sweep", typeof swept.batch === "string");
check("stock shrank by that many", live("t").length === before - stale.length);
check("chili is off the shelves", !live("t").some((i) => i.id === "leftover-chili"));

const last = lastSweep("t");
check("the sweep is offered for undo", last?.batch === swept.batch);
check("undo lists what it took", (last?.items.length ?? 0) === stale.length);

// One retraction puts everything back exactly as it was.
append("t", [{ op: "undo", batch_target: swept.batch!, why: "still here" }]);
check("stock is restored", live("t").length === before);
check(
  "chili is back",
  live("t").some((i) => i.id === "leftover-chili"),
);
check("a retracted sweep is not offered again", lastSweep("t") === null);

// The next pass must not re-remove what was just rescued, although it is still old.
check("re-sweeping does not immediately re-remove", staleItems("t").length === 0);
