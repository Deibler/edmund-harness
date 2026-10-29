/**
 * coverage() counted distinct indexed documents on every 60 s tick: a
 * synchronous COUNT(DISTINCT ...) over every artifact row, 11.3 s from a cold
 * page cache on 2026-10-29, on the daemon's main thread. It is computed at
 * most every 10 minutes now.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatDb } from "../src/imessage/db.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { Indexer } from "../src/memory/indexer.ts";
import { VectorStore } from "../src/memory/vector-store.ts";

const chatDbStub = {
  query: () => ({ all: () => [], get: () => ({ n: 0 }) }),
} as unknown as ChatDb;

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
