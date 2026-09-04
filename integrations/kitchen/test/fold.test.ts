process.env.KITCHEN_DIR = "/tmp/kitchen-test-scratch";
process.env.KITCHEN_PRINCIPAL = "test:reviewer";

const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
rmSync(process.env.KITCHEN_DIR, { recursive: true, force: true });
mkdirSync(`${process.env.KITCHEN_DIR}/tenants/t`, { recursive: true });
writeFileSync(
  `${process.env.KITCHEN_DIR}/tenants.json`,
  JSON.stringify({
    version: 1,
    tenants: {
      t: {
        name: "t",
        created: "2026-01-01T00:00:00+00:00",
        members: ["test:reviewer"],
        note: null,
      },
    },
  }),
);

const { fold, append } = await import("../src/store.ts");
const { spend } = await import("../src/insights.ts");

import { expect, test } from "bun:test";

/** Same shape as the old script helper, but the comparison is a real test. */
const check = (name: string, got: unknown, want: unknown) => {
  test(name, () => {
    expect(JSON.parse(JSON.stringify(got ?? null))).toEqual(
      JSON.parse(JSON.stringify(want ?? null)),
    );
  });
};

const ev = (o: Record<string, unknown>) => ({
  qty: null,
  unit: null,
  fields: {},
  why: "t",
  src: "t",
  ...o,
});

// ── A. restocking must not inherit the emptiness the last use left behind ──
console.log("\nA. add clears a stale out/zero");

append("t", [ev({ op: "add", item: "olive-oil", fields: { level: "full", name: "Olive oil" } })]);
append("t", [ev({ op: "use", item: "olive-oil" })]); // used it all
check("staple after use-all is gone", fold("t")["olive-oil"]!.gone, true);
append("t", [ev({ op: "add", item: "olive-oil" })]); // bought more, nobody counted
const oil = fold("t")["olive-oil"]!;
check("restocked staple is not gone", oil.gone, false);
check("restocked staple level is not 'out'", oil.level, "full");
check("restocked staple qty is uncounted, not 0", oil.qty, null);

append("t", [ev({ op: "add", item: "eggs", qty: 12, fields: { name: "Eggs" } })]);
append("t", [ev({ op: "use", item: "eggs", qty: 12 })]);
check("counted item to zero is out", fold("t").eggs!.level, "out");
append("t", [ev({ op: "add", item: "eggs", qty: 12 })]);
const eggs = fold("t").eggs!;
check("rebought eggs are counted", eggs.qty, 12);
check("rebought eggs are not still 'out'", eggs.level, "full");

// an explicit level on the add still wins
append("t", [ev({ op: "add", item: "flour", fields: { level: "low", name: "Flour" } })]);
check("explicit level on add is honoured", fold("t").flour!.level, "low");

// ── B. price is a line total, not a rate ──
console.log("\nB. spend does not multiply price by qty");

append("t", [
  ev({ op: "add", item: "r-eggs", qty: 12, unit: "ct", fields: { name: "E", price: 1.46 } }),
  ev({ op: "add", item: "r-sugar", qty: 9, unit: "cup", fields: { name: "S", price: 2.89 } }),
  ev({ op: "add", item: "r-beef", qty: 1, unit: "pkg", fields: { name: "B", price: 15.35 } }),
]);
check("line totals sum as printed", spend("t", 90).total, 19.7);

// ── C. weekly rate credits each trip with the stretch it feeds ──
console.log("\nC. perWeek fencepost");

const day = (n: number) =>
  new Date(Date.now() - n * 86400000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
mkdirSync(`${process.env.KITCHEN_DIR}/tenants/w`, { recursive: true });
writeFileSync(
  `${process.env.KITCHEN_DIR}/tenants/w/events.jsonl`,
  `${[14, 7, 0]
    .map((d, i) =>
      JSON.stringify({
        op: "add",
        item: `shop${i}`,
        qty: 1,
        unit: null,
        ts: day(d),
        batch: `b${i}`,
        fields: { name: `s${i}`, price: 100 },
        why: "t",
        src: "receipt:aldi-2026-08-01",
      }),
    )
    .join("\n")}\n`,
);
writeFileSync(
  `${process.env.KITCHEN_DIR}/tenants.json`,
  JSON.stringify({
    version: 1,
    tenants: {
      t: {
        name: "t",
        created: "2026-01-01T00:00:00+00:00",
        members: ["test:reviewer"],
        note: null,
      },
      w: { name: "w", created: "2026-01-01T00:00:00+00:00", members: ["test:w"], note: null },
    },
  }),
);
const s = spend("w", 90);
check("3 weekly $100 shops read as $100/wk, not $150", s.perWeek, 100);
check("raw span still reported honestly", s.spanDays, 14);
