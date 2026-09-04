/**
 * Regression tests for the artifact-indexer watermark.
 *
 * The bug being prevented (2026-07-28): the walk advanced the mtime
 * watermark over EVERY candidate it found, then kept only 200 per tick —
 * so every capped-out file landed below the watermark and became
 * permanently invisible. Production impact: 9,272 artifacts stranded,
 * coverage frozen at 22% while the indexer reported itself caught up.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatDb } from "../src/imessage/db.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { Indexer } from "../src/memory/indexer.ts";
import { VectorStore } from "../src/memory/vector-store.ts";

/** ChatDb stub: the artifact path never touches chat.db; the message
 *  pass and coverage() just need empty result shapes. */
const chatDbStub = {
  query: () => ({
    all: () => [],
    get: () => ({ n: 0 }),
  }),
} as unknown as ChatDb;

function setup(fileCount: number) {
  const root = mkdtempSync(join(tmpdir(), "art-wm-"));
  const sandboxRoot = join(root, "sandbox");
  const sessionDir = join(sandboxRoot, "dm_test");
  mkdirSync(sessionDir, { recursive: true });
  // Staggered mtimes, oldest first, all safely in the past.
  const base = Date.now() - fileCount * 2000 - 60_000;
  for (let i = 0; i < fileCount; i++) {
    const p = join(sessionDir, `note-${String(i).padStart(4, "0")}.md`);
    writeFileSync(p, `artifact number ${i} with some indexable text`);
    const t = new Date(base + i * 2000);
    utimesSync(p, t, t);
  }
  const store = new VectorStore(join(root, "recall.sqlite"));
  const provider = new HashEmbedProvider("hash", 32);
  store.resetIfModelChanged("hash", 32);
  const indexer = new Indexer(
    chatDbStub,
    store,
    provider,
    {
      maxChars: 2000,
      minChars: 1,
      batchSize: 64,
      chunkSize: 500,
      backfillDays: 0,
      sandboxRoot,
    },
    undefined,
    () => "iMessage;-;+15550100001",
  );
  return {
    root,
    store,
    indexer,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("artifact watermark vs the per-tick cap", () => {
  test("capped-out files are indexed on subsequent ticks, not stranded", async () => {
    const { store, indexer, cleanup } = setup(250);
    try {
      const t1 = await indexer.tick();
      expect(t1.artifacts).toBe(200); // per-tick cap
      // THE regression assertion: the watermark must NOT have advanced
      // over the 50 capped-out files.
      const t2 = await indexer.tick();
      expect(t2.artifacts).toBe(50);
      expect(store.countByKind("artifact")).toBe(250);
    } finally {
      cleanup();
    }
  });

  test("unchanged files cost nothing on later ticks (skip-if-current)", async () => {
    const { indexer, cleanup } = setup(10);
    try {
      expect((await indexer.tick()).artifacts).toBe(10);
      expect((await indexer.tick()).artifacts).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("walk_v2 recovery reset re-walks below a corrupted watermark without re-embedding current rows", async () => {
    const { root, store, indexer, cleanup } = setup(10);
    try {
      expect((await indexer.tick()).artifacts).toBe(10);
      // Simulate the production corruption: watermark jammed at "now"
      // with stranded files below it (never indexed, mtime in the past),
      // on a store that predates the v2 flag.
      const sessionDir = join(root, "sandbox", "dm_test");
      const strandedAt = new Date(Date.now() - 30_000);
      for (let i = 0; i < 5; i++) {
        const p = join(sessionDir, `stranded-${i}.md`);
        writeFileSync(p, `stranded artifact ${i}`);
        utimesSync(p, strandedAt, strandedAt);
      }
      store.setWatermark("artifact.walk_v2", 0);
      store.setWatermark("artifact.mtime", Date.now());
      const t = await indexer.tick();
      // Recovery reset re-walked everything: the 5 stranded files got
      // indexed, the 10 current rows were skip-if-current (no re-embed).
      expect(t.artifacts).toBe(5);
      expect(store.countByKind("artifact")).toBe(15);
      expect(store.getWatermark("artifact.walk_v2")).toBe(1);
    } finally {
      cleanup();
    }
  });
});
