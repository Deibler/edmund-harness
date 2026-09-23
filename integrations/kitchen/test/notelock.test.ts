/**
 * One note sync at a time, across processes.
 *
 * Two syncs driving the same browser tab corrupt each other's selection and
 * clipboard. Every entry point goes through `syncNote`, which takes the lock,
 * so no caller can forget it. The lock is a file with a timestamp so it
 * survives a killed process and can be declared abandoned.
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
    // Waiting means the two syncs never overlapped at all.
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
    // A file lock with a timestamp is what survives a kill -9.
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
    // Otherwise a waiter could outlive the lock it waits on.
    expect(WAIT_MS).toBeLessThan(4 * 60 * 1000);
  });
});
