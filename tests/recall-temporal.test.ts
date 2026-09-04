/**
 * Tests for the new recall features:
 *   - VectorStore.search recency boost (rankScore reorders results)
 *   - VectorStore.search untilMs upper bound
 *   - VectorStore.countByKind for the coverage telemetry
 *   - autoRecall splits hits into recent + deep blocks
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRecall } from "../src/memory/auto-recall.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { type IndexRow, VectorStore, normalize } from "../src/memory/vector-store.ts";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "temporal-"));
  const store = new VectorStore(join(dir, "r.sqlite"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seed(
  store: VectorStore,
  provider: HashEmbedProvider,
  docs: Array<{ ref: string; text: string; ts: number; chatGuid?: string }>,
): Promise<void> {
  const r = await provider.embed(docs.map((d) => d.text));
  const rows: IndexRow[] = docs.map((d, i) => ({
    ref: d.ref,
    kind: "message",
    chatGuid: d.chatGuid ?? "chatA",
    sender: "alice",
    ts: d.ts,
    text: d.text,
    vec: normalize(r.vectors[i]!),
    model: "hash",
  }));
  store.upsert(rows);
}

describe("VectorStore recency boost", () => {
  test("rankScore reflects cosine when no recency params", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      await seed(store, provider, [{ ref: "msg:a", text: "patio restaurant", ts: now - 86400000 }]);
      const q = (await provider.embed(["patio restaurant"])).vectors[0]!;
      normalize(q);
      const hits = store.search(q, {
        scope: { kind: "global" },
        limit: 10,
      });
      expect(hits.length).toBe(1);
      expect(hits[0]!.rankScore).toBeCloseTo(hits[0]!.score, 6);
    } finally {
      cleanup();
    }
  });

  test("recency boost lifts younger same-cosine hit above older", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      // Same text → same cosine. Different ages.
      await seed(store, provider, [
        { ref: "msg:old", text: "exact same words", ts: now - 100 * 86400000 },
        { ref: "msg:new", text: "exact same words", ts: now - 1 * 86400000 },
      ]);
      const q = (await provider.embed(["exact same words"])).vectors[0]!;
      normalize(q);
      const hits = store.search(q, {
        scope: { kind: "global" },
        limit: 10,
        recencyHalfLifeMs: 14 * 86400000,
        recencyBoost: 1.0,
        nowMs: now,
      });
      expect(hits.length).toBe(2);
      expect(hits[0]!.ref).toBe("msg:new");
      expect(hits[1]!.ref).toBe("msg:old");
      // Raw cosine is identical; rankScore differs.
      expect(hits[0]!.score).toBeCloseTo(hits[1]!.score, 6);
      expect(hits[0]!.rankScore).toBeGreaterThan(hits[1]!.rankScore);
    } finally {
      cleanup();
    }
  });

  test("untilMs upper bound excludes recent rows", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      await seed(store, provider, [
        { ref: "msg:fresh", text: "shared topic", ts: now - 86400000 },
        { ref: "msg:deep", text: "shared topic", ts: now - 60 * 86400000 },
      ]);
      const q = (await provider.embed(["shared topic"])).vectors[0]!;
      normalize(q);
      const hits = store.search(q, {
        scope: { kind: "global" },
        untilMs: now - 30 * 86400000,
      });
      expect(hits.map((h) => h.ref)).toEqual(["msg:deep"]);
    } finally {
      cleanup();
    }
  });
});

describe("VectorStore.countByKind", () => {
  test("returns 0 on fresh store", () => {
    const { store, cleanup } = tempStore();
    try {
      expect(store.countByKind("message")).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("counts only the requested kind", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      await seed(store, provider, [
        { ref: "msg:1", text: "x", ts: Date.now() },
        { ref: "msg:2", text: "y", ts: Date.now() },
      ]);
      const r = (await provider.embed(["z"])).vectors[0]!;
      store.upsert([
        {
          ref: "person:a",
          kind: "person-file",
          chatGuid: null,
          sender: null,
          ts: Date.now(),
          text: "z",
          vec: normalize(r),
          model: "hash",
        },
      ]);
      expect(store.countByKind("message")).toBe(2);
      expect(store.countByKind("person-file")).toBe(1);
      expect(store.countByKind("artifact")).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("autoRecall split into recent + deep", () => {
  test("partitions hits by deep_split_days boundary", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      await seed(store, provider, [
        { ref: "msg:recent", text: "patio restaurant", ts: now - 5 * 86400000 },
        { ref: "msg:deep1", text: "patio restaurant", ts: now - 60 * 86400000 },
        { ref: "msg:deep2", text: "patio restaurant", ts: now - 90 * 86400000 },
      ]);
      const r = await autoRecall("patio restaurant", provider, store, {
        chatGuid: "chatA",
        limit: 10,
        minScore: 0.0,
        excludeRecentMs: 24 * 3_600_000,
        deepSplitDays: 30,
        deepLimit: 5,
        recencyHalfLifeMs: 14 * 86400000,
        recencyBoost: 1.0,
      });
      expect(r.recent.map((h) => h.ref)).toEqual(["msg:recent"]);
      const deepRefs = r.deep.map((h) => h.ref).sort();
      expect(deepRefs).toEqual(["msg:deep1", "msg:deep2"]);
    } finally {
      cleanup();
    }
  });

  test("deepLimit=0 disables the deep block", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      await seed(store, provider, [
        { ref: "msg:r", text: "topic", ts: now - 5 * 86400000 },
        { ref: "msg:d", text: "topic", ts: now - 90 * 86400000 },
      ]);
      const r = await autoRecall("topic", provider, store, {
        chatGuid: "chatA",
        limit: 10,
        minScore: 0.0,
        excludeRecentMs: 24 * 3_600_000,
        deepSplitDays: 30,
        deepLimit: 0,
      });
      expect(r.deep).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("split disabled when deepSplitDays unset — everything is recent", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      await seed(store, provider, [
        { ref: "msg:r", text: "topic", ts: now - 5 * 86400000 },
        { ref: "msg:d", text: "topic", ts: now - 90 * 86400000 },
      ]);
      const r = await autoRecall("topic", provider, store, {
        chatGuid: "chatA",
        limit: 10,
        minScore: 0.0,
        excludeRecentMs: 24 * 3_600_000,
      });
      const refs = r.recent.map((h) => h.ref).sort();
      expect(refs).toEqual(["msg:d", "msg:r"]);
      expect(r.deep).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("recencyBoost surfaces newer hit first in recent block", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      await seed(store, provider, [
        { ref: "msg:old", text: "shared topic", ts: now - 25 * 86400000 },
        { ref: "msg:new", text: "shared topic", ts: now - 2 * 86400000 },
      ]);
      const r = await autoRecall("shared topic", provider, store, {
        chatGuid: "chatA",
        limit: 10,
        minScore: 0.0,
        excludeRecentMs: 24 * 3_600_000,
        deepSplitDays: 30,
        deepLimit: 0,
        recencyHalfLifeMs: 7 * 86400000,
        recencyBoost: 2.0,
      });
      expect(r.recent[0]!.ref).toBe("msg:new");
    } finally {
      cleanup();
    }
  });
});
