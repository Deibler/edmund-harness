/**
 * The embedding worker ran requests first in, first out, so a 4 ms query
 * waited behind every index batch already queued (median query embed 730 ms
 * in the daemon from 2026-10-26). Queries now go before queued index work.
 */
import { describe, expect, test } from "bun:test";
import { laneScheduler } from "../src/memory/embed-lanes.ts";

type Item = { name: string; lane: "query" | "index" };

describe("laneScheduler", () => {
  test("a query that arrives mid-batch runs next, ahead of queued index work", async () => {
    const order: string[] = [];
    let release!: () => void;
    const firstRunning = new Promise<void>((r) => {
      release = r;
    });
    const done = new Promise<void>((resolve) => {
      const push = laneScheduler<Item>(
        (i) => i.lane,
        async (i) => {
          order.push(i.name);
          if (i.name === "index-1") await firstRunning;
          if (order.length === 4) resolve();
        },
      );
      push({ name: "index-1", lane: "index" });
      push({ name: "index-2", lane: "index" });
      push({ name: "index-3", lane: "index" });
      push({ name: "query", lane: "query" });
      release();
    });
    await done;
    expect(order).toEqual(["index-1", "query", "index-2", "index-3"]);
  });

  test("runs one item at a time", async () => {
    let active = 0;
    let most = 0;
    await new Promise<void>((resolve) => {
      let n = 0;
      const push = laneScheduler<Item>(
        (i) => i.lane,
        async () => {
          active++;
          most = Math.max(most, active);
          await new Promise((r) => setTimeout(r, 2));
          active--;
          if (++n === 5) resolve();
        },
      );
      for (let i = 0; i < 5; i++) push({ name: `i${i}`, lane: i % 2 ? "query" : "index" });
    });
    expect(most).toBe(1);
  });
});
