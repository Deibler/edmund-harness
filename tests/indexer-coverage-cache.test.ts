/**
 * coverage() counted distinct indexed documents on every 60 s tick: a
 * synchronous COUNT(DISTINCT ...) over every artifact row, 11.3 s from a cold
 * page cache on 2026-10-29, on the daemon's main thread. It is computed at
 * most every 10 minutes now.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatDb } from "../src/imessage/db.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { Indexer } from "../src/memory/indexer.ts";
import { VectorStore } from "../src/memory/vector-store.ts";

const chatDbStub = {
  query: () => ({ all: () => [], get: () => ({ n: 0 }) }),
} as unknown as ChatDb;

describe("indexer standing down", () => {
  // A tick holds the daemon's main thread for a second or two. During a
  // FaceTime call nothing may: the tick is skipped and its work waits.
  test("a tick does no indexing while told to stand down, and catches up after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stand-down-"));
    const people = join(dir, "people");
    mkdirSync(people);
    writeFileSync(
      join(people, "15550100001.md"),
      "# Dana\n\n## Notes\n- Likes tacos and long walks on the beach every single weekend.\n",
    );
    const store = new VectorStore(join(dir, "v.sqlite"));
    let onCall = true;
    const indexer = new Indexer(
      chatDbStub,
      store,
      new HashEmbedProvider("h", 8),
      {
        maxChars: 2000,
        minChars: 1,
        batchSize: 8,
        chunkSize: 500,
        backfillDays: 0,
        standDown: () => onCall,
      },
      people,
    );
    try {
      expect((await indexer.tick()).people).toBe(0);
      expect(store.countByKind("person-file")).toBe(0);
      onCall = false;
      expect((await indexer.tick()).people).toBeGreaterThan(0);
      expect(store.countByKind("person-file")).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("indexer coverage", () => {
  test("counts indexed documents once per ten minutes, not every tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coverage-cache-"));
    const store = new VectorStore(join(dir, "v.sqlite"));
    let counts = 0;
    const real = store.countDocsByKind.bind(store);
    store.countDocsByKind = (kind) => {
      counts++;
      return real(kind);
    };
    const indexer = new Indexer(chatDbStub, store, new HashEmbedProvider("h", 8), {
      maxChars: 2000,
      minChars: 1,
      batchSize: 8,
      chunkSize: 500,
      backfillDays: 0,
    });
    try {
      await indexer.tick();
      await indexer.tick();
      indexer.coverage();
      expect(counts).toBe(2); // artifacts + people, once
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
