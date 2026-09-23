/**
 * What counts as a shopping trip, which is what ends a "not this trip" skip.
 *
 * Only a receipt, a logged shop or ticking lines in a store count; a leftover,
 * a shelf photo or a correction does not. Also pins how skips recorded under
 * the old count are placed on the new one.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KitchenEvent } from "../src/types.ts";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-trips-"));
process.env.KITCHEN_DIR = BASE;

const { purchaseHistory, tripKey } = await import("../src/shopping.ts");
const { readBook, restockPath, skipped } = await import("../src/restock.ts");

let n = 0;
const ev = (e: Partial<KitchenEvent>): KitchenEvent => ({
  op: "add",
  item: "eggs",
  batch: `b${n++}`,
  ts: "2026-09-01T12:00:00+00:00",
  ...e,
});

describe("tripKey", () => {
  test("a receipt, a shop without one and a ticked list line are trips", () => {
    expect(tripKey(ev({ src: "receipt:giant-2026-01-10" }))).toBe("receipt:giant-2026-01-10");
    expect(tripKey(ev({ src: "trip:aldi-2026-01-12" }))).toBe("trip:aldi-2026-01-12");
    expect(tripKey(ev({ src: "shopped", batch: "tick" }))).toBe("tick");
    expect(tripKey(ev({ op: "trip", item: null, src: null, batch: "total" }))).toBe("total");
  });

  test("food arriving any other way is not", () => {
    for (const src of ["cooked", "photo", "photo-inventory", "onboard", "told in chat", null])
      expect(tripKey(ev({ src }))).toBeNull();
  });

  test("using, correcting or tossing food is never a trip, whatever the source", () => {
    for (const op of ["use", "set", "toss"] as const)
      expect(tripKey(ev({ op, src: "receipt:giant-1" }))).toBeNull();
  });
});

describe("purchaseHistory", () => {
  test("one receipt is one trip however many times it is written", () => {
    const h = purchaseHistory([
      ev({ src: "receipt:giant-1" }),
      ev({ src: "receipt:giant-1" }),
      ev({ op: "trip", item: null, src: "receipt:giant-1" }),
    ]);
    expect(h.trips).toBe(1);
  });

  test("only a purchase says when something was bought", () => {
    const h = purchaseHistory([
      ev({ item: "salt", src: "photo", ts: "2026-09-20T12:00:00+00:00" }),
      ev({ item: "milk", src: "receipt:giant-1", ts: "2026-09-10T12:00:00+00:00" }),
    ]);
    expect(h.lastBought.has("salt")).toBe(false);
    expect(h.lastBought.get("milk")).toBe("2026-09-10T12:00:00+00:00");
  });

  test("shopsBy places a moment by the trips that had started by then", () => {
    const h = purchaseHistory([
      ev({ src: "receipt:a", ts: "2026-09-01T12:00:00+00:00" }),
      ev({ src: "receipt:b", ts: "2026-09-10T12:00:00+00:00" }),
      ev({ op: "trip", item: null, src: "receipt:a", ts: "2026-09-15T12:00:00+00:00" }),
    ]);
    expect(h.shopsBy("2026-08-01T00:00:00+00:00")).toBe(0);
    expect(h.shopsBy("2026-09-05T00:00:00+00:00")).toBe(1);
    expect(h.shopsBy("2026-09-20T00:00:00+00:00")).toBe(2);
  });
});

describe("skips written before the count changed", () => {
  const write = (skips: unknown) => {
    const p = restockPath("hh");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 1, items: {}, skips }));
  };
  const events = [
    ev({ src: "receipt:a", ts: "2026-09-01T12:00:00+00:00" }),
    ev({ src: "cooked", ts: "2026-09-05T12:00:00+00:00" }),
    ev({ src: "photo", ts: "2026-09-06T12:00:00+00:00" }),
  ];

  test("an old skip is placed by its time, not by a number taken on the old count", () => {
    // A skip recorded as 9 on the old count would outlive eight trips on the
    // new one, so it is placed by its time instead.
    write({ broth: { at: "2026-09-07T00:00:00+00:00", trips: 9 } });
    const book = readBook("hh");
    expect(book.skips.broth?.shops).toBeNull();
    const before = purchaseHistory(events);
    expect(skipped(book, "broth", before.trips, before.shopsBy)).toBe(true);
    const after = purchaseHistory([
      ...events,
      ev({ src: "receipt:b", ts: "2026-09-10T12:00:00+00:00" }),
    ]);
    expect(skipped(book, "broth", after.trips, after.shopsBy)).toBe(false);
  });

  test("an old skip made before the last shop is already spent", () => {
    write({ broth: { at: "2026-08-01T00:00:00+00:00", trips: 3 } });
    const h = purchaseHistory(events);
    expect(skipped(readBook("hh"), "broth", h.trips, h.shopsBy)).toBe(false);
  });

  test("an old skip with no readable time is dropped rather than guessed at", () => {
    write({ broth: { at: "yesterday", trips: 3 } });
    expect(readBook("hh").skips.broth).toBeUndefined();
  });

  test("a new skip keeps its own count", () => {
    write({ broth: { at: "2026-09-07T00:00:00+00:00", shops: 1 } });
    const book = readBook("hh");
    expect(book.skips.broth?.shops).toBe(1);
    const h = purchaseHistory(events);
    expect(skipped(book, "broth", h.trips, () => 99)).toBe(true);
  });
});
