/**
 * Idempotency tests for the recall indexer + vector store.
 *
 * The Indexer reads from a real ChatDb, which we'd need an iMessage-
 * schema fixture for. To keep these tests pure we exercise the two
 * primitives the idempotency guarantees rest on:
 *
 *  1. `VectorStore.upsert` is INSERT OR REPLACE — same ref + repeat
 *     upsert never duplicates rows.
 *  2. `VectorStore.hasRef` correctly identifies already-indexed refs
 *     (the in-indexer skip).
 *  3. `VectorStore.resetIfModelChanged` resets watermarks on model
 *     change and is a no-op on match.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { type IndexRow, VectorStore, normalize } from "../src/memory/vector-store.ts";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "idemp-"));
  const store = new VectorStore(join(dir, "r.sqlite"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function row(ref: string, text: string, model = "hash"): Promise<IndexRow> {
  const r = await new HashEmbedProvider(model, 64).embed([text]);
  return {
    ref,
    kind: "message",
    chatGuid: "chatA",
    sender: "alice",
    ts: Date.now(),
    text,
    vec: normalize(r.vectors[0]!),
    model,
  };
}

describe("upsert idempotency", () => {
  test("same ref upserted twice keeps count at 1", async () => {
    const { store, cleanup } = tempStore();
    try {
      store.upsert([await row("msg:1", "hello")]);
      store.upsert([await row("msg:1", "hello")]);
      store.upsert([await row("msg:1", "hello")]);
      expect(store.count()).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("100 distinct refs → 100 rows; re-running same batch keeps 100", async () => {
    const { store, cleanup } = tempStore();
    try {
      const rows: IndexRow[] = [];
      for (let i = 0; i < 100; i++) rows.push(await row(`msg:${i}`, `text-${i}`));
      store.upsert(rows);
      expect(store.count()).toBe(100);
      store.upsert(rows);
      expect(store.count()).toBe(100);
    } finally {
      cleanup();
    }
  });

  test("hasRef tracks inserted refs", async () => {
    const { store, cleanup } = tempStore();
    try {
      expect(store.hasRef("msg:1")).toBe(false);
      store.upsert([await row("msg:1", "hello")]);
      expect(store.hasRef("msg:1")).toBe(true);
      expect(store.hasRef("msg:2")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("watermark persistence across reopens", () => {
  test("watermark survives close/reopen of the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "idemp-"));
    const path = join(dir, "r.sqlite");
    try {
      let s = new VectorStore(path);
      s.setWatermark("msg.rowid", 42);
      s.close();
      s = new VectorStore(path);
      expect(s.getWatermark("msg.rowid")).toBe(42);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resetIfModelChanged", () => {
  test("no-op on first call with fresh DB then matching call", () => {
    const { store, cleanup } = tempStore();
    try {
      store.setWatermark("msg.rowid", 100);
      // First call records the model and dim; does NOT zero the watermark
      // because the stored model is null on a fresh DB so it counts as a
      // change. Document that explicitly.
      const first = store.resetIfModelChanged("modelA", 64);
      expect(first).toBe(true);
      expect(store.getWatermark("msg.rowid")).toBe(0);
      // Restore the watermark to simulate post-backfill state.
      store.setWatermark("msg.rowid", 200);
      const second = store.resetIfModelChanged("modelA", 64);
      expect(second).toBe(false);
      expect(store.getWatermark("msg.rowid")).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("resets on model name change", () => {
    const { store, cleanup } = tempStore();
    try {
      store.resetIfModelChanged("modelA", 64);
      store.setWatermark("msg.rowid", 999);
      store.setWatermark("person.mtime", 1234567);
      const changed = store.resetIfModelChanged("modelB", 64);
      expect(changed).toBe(true);
      expect(store.getWatermark("msg.rowid")).toBe(0);
      expect(store.getWatermark("person.mtime")).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("resets on dim change even with same model name", () => {
    const { store, cleanup } = tempStore();
    try {
      store.resetIfModelChanged("modelA", 64);
      store.setWatermark("msg.rowid", 500);
      const changed = store.resetIfModelChanged("modelA", 128);
      expect(changed).toBe(true);
      expect(store.getWatermark("msg.rowid")).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("countForModel filters by model", async () => {
    const { store, cleanup } = tempStore();
    try {
      store.upsert([await row("msg:1", "x", "modelA")]);
      store.upsert([await row("msg:2", "y", "modelA")]);
      store.upsert([await row("msg:3", "z", "modelB")]);
      expect(store.countForModel("modelA")).toBe(2);
      expect(store.countForModel("modelB")).toBe(1);
    } finally {
      cleanup();
    }
  });
});
