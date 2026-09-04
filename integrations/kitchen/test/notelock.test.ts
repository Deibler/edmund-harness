/**
 * One sync of a note at a time, across every process that can start one.
 *
 * This is a regression file with a date on it. The lock existed from the first
 * version and its own comment named all three callers that could collide — and
 * it was then taken on one of them. On the evening of 2026-08-20 an MCP tool
 * and the ten-second watch pass drove the same browser tab into the same note
 * within seconds of each other. Neither failed cleanly: they selected-all over
 * each other, took each other's clipboard, and navigated the page out from
 * under a script that was still running. What reached a person was "the note
 * could not be read back after writing", then "Inspected target navigated or
 * closed", and a shared shopping list holding a heading twice.
 *
 * So what is pinned here is not "the lock works". It is that holding it is not
 * something a caller can forget.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "/tmp/kitchen-notelock-test";
rmSync(BASE, { recursive: true, force: true });
mkdirSync(BASE, { recursive: true });
process.env.KITCHEN_DIR = BASE;

const { syncRunning, withNoteLock, WAIT_MS } = await import("../src/notesync.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("only one thing at a time may hold the note", () => {
  test("a second caller that will not wait is turned away, not queued", async () => {
    let inside = false;
    const first = withNoteLock(0, async () => {
      inside = true;
      await sleep(150);
      inside = false;
      return "first";
    });
    await sleep(20);
    expect(inside).toBe(true);
    // The watch pass, which runs again in ten seconds and must never stack.
    expect(await withNoteLock(0, async () => "second")).toBeNull();
    expect(await first).toBe("first");
  });

  test("a caller with a person waiting on it queues behind and then runs", async () => {
    const order: string[] = [];
    const first = withNoteLock(0, async () => {
      order.push("background in");
      await sleep(200);
      order.push("background out");
    });
    await sleep(20);
    const second = await withNoteLock(3_000, async () => {
      order.push("tool in");
      return "ran";
    });
    await first;
    expect(second).toBe("ran");
    // The point of the wait: the tool did not merely survive the collision, it
    // never overlapped at all.
    expect(order).toEqual(["background in", "background out", "tool in"]);
  });

  test("the lock is released even when the work throws", async () => {
    await expect(
      withNoteLock(0, async () => {
        throw new Error("iCloud fell over");
      }),
    ).rejects.toThrow("iCloud fell over");
    expect(syncRunning()).toBe(false);
    expect(await withNoteLock(0, async () => "free")).toBe("free");
  });

  test("a lock left behind by a killed process does not wedge the note forever", async () => {
    // No in-memory guard survives a kill -9, which is the whole reason this is
    // a file with a timestamp in it rather than a promise.
    writeFileSync(join(BASE, "notes.lock"), `${Date.now() - 60 * 60 * 1000}|99999`);
    expect(syncRunning()).toBe(false);
    expect(await withNoteLock(0, async () => "recovered")).toBe("recovered");
  });

  test("but a lock somebody is genuinely holding is respected", async () => {
    writeFileSync(join(BASE, "notes.lock"), `${Date.now()}|99999`);
    expect(syncRunning()).toBe(true);
    expect(await withNoteLock(0, async () => "stolen")).toBeNull();
    rmSync(join(BASE, "notes.lock"), { force: true });
  });

  test("waiting is bounded, so a stuck holder cannot hang a tool call forever", async () => {
    writeFileSync(join(BASE, "notes.lock"), `${Date.now()}|99999`);
    const began = Date.now();
    expect(await withNoteLock(1_200, async () => "never")).toBeNull();
    const took = Date.now() - began;
    expect(took).toBeGreaterThanOrEqual(1_200);
    expect(took).toBeLessThan(4_000);
    rmSync(join(BASE, "notes.lock"), { force: true });
  });

  test("the wait a person-facing caller uses is shorter than the lock's own life", () => {
    // Otherwise a caller could still be waiting after the lock it is waiting on
    // has been declared abandoned, which is a queue that never drains.
    expect(WAIT_MS).toBeLessThan(4 * 60 * 1000);
  });
});
