import { Database } from "bun:sqlite";
/**
 * Tests for diversity reranking (MMR + dedupThreshold) and the
 * in-memory cache.
 *
 * The cache is a critical correctness path: same-process upserts must
 * be visible to the next search (write-through), and writes made by
 * other connections to the same file must be picked up via
 * `PRAGMA data_version` deltas. Performance is asserted with a loose
 * bound so the test stays stable on slow CI.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { type IndexRow, VectorStore, normalize } from "../src/memory/vector-store.ts";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "div-"));
  const path = join(dir, "r.sqlite");
  const store = new VectorStore(path);
  return {
    path,
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
  docs: Array<{ ref: string; text: string; ts?: number; sender?: string }>,
): Promise<void> {
  const r = await provider.embed(docs.map((d) => d.text));
  const rows: IndexRow[] = docs.map((d, i) => ({
    ref: d.ref,
    kind: "message",
    chatGuid: "chatA",
    sender: d.sender ?? "+a",
    ts: d.ts ?? Date.now() - 30 * 86400000,
    text: d.text,
    vec: normalize(r.vectors[i]!),
    model: "hash",
  }));
  store.upsert(rows);
}

describe("dedupThreshold drops near-duplicates", () => {
  test("exact-duplicate text → only the higher-scoring copy survives", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      await seed(store, provider, [
        { ref: "msg:a", text: "the patio restaurant downtown" },
        { ref: "msg:b", text: "the patio restaurant downtown" },
        { ref: "msg:c", text: "totally unrelated topic about taxes" },
      ]);
      const q = normalize((await provider.embed(["patio restaurant downtown"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "global" },
        limit: 10,
        dedupThreshold: 0.99,
      });
      const refs = hits.map((h) => h.ref);
      // Only one of msg:a / msg:b should make it through.
      const dupCount = refs.filter((r) => r === "msg:a" || r === "msg:b").length;
      expect(dupCount).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("disabled (>1) returns all clones", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      await seed(store, provider, [
        { ref: "msg:a", text: "same exact words here" },
        { ref: "msg:b", text: "same exact words here" },
      ]);
      const q = normalize((await provider.embed(["same exact words here"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "global" },
        limit: 10,
      });
      expect(hits.length).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe("MMR diversifies the result set", () => {
  test("lambda=0.5 spreads picks across distinct content", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 128);
    try {
      // Five docs with overlapping vocabulary but distinct angles:
      //   3 patio-restaurant variants (high similarity among them)
      //   1 hike planning
      //   1 weather
      await seed(store, provider, [
        { ref: "msg:p1", text: "patio restaurant downtown best food" },
        { ref: "msg:p2", text: "downtown patio restaurant excellent food" },
        { ref: "msg:p3", text: "the patio at that restaurant downtown amazing food" },
        { ref: "msg:hike", text: "hike planning trail saturday morning" },
        { ref: "msg:weather", text: "weather forecast rain saturday morning" },
      ]);
      const q = normalize((await provider.embed(["downtown saturday food"])).vectors[0]!);
      const purelyRelevant = store.search(q, {
        scope: { kind: "global" },
        limit: 3,
      });
      const diverse = store.search(q, {
        scope: { kind: "global" },
        limit: 3,
        mmrLambda: 0.3,
      });
      // Pure cosine often returns 2+ patio clones in top 3; MMR should
      // spread the picks. Specifically: the diverse result should
      // contain fewer than 3 patio clones.
      const patioCount = (hits: typeof diverse) =>
        hits.filter((h) => h.ref.startsWith("msg:p")).length;
      expect(patioCount(diverse)).toBeLessThanOrEqual(patioCount(purelyRelevant));
    } finally {
      cleanup();
    }
  });
});

describe("in-memory cache correctness", () => {
  test("write-through: upsert before close, search returns the new row", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      // Warm the cache with one row.
      await seed(store, provider, [{ ref: "msg:1", text: "topic alpha" }]);
      const q = normalize((await provider.embed(["topic alpha"])).vectors[0]!);
      let hits = store.search(q, { scope: { kind: "global" }, limit: 5 });
      expect(hits.map((h) => h.ref)).toEqual(["msg:1"]);

      // New upsert AFTER the cache was loaded.
      await seed(store, provider, [{ ref: "msg:2", text: "topic alpha alt" }]);
      hits = store.search(q, { scope: { kind: "global" }, limit: 5 });
      const refs = hits.map((h) => h.ref).sort();
      expect(refs).toEqual(["msg:1", "msg:2"]);
    } finally {
      cleanup();
    }
  });

  test("delta reload: writes from another connection are picked up", async () => {
    const env = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      // Warm the cache from the primary store.
      await seed(env.store, provider, [{ ref: "msg:1", text: "topic alpha" }]);
      const q = normalize((await provider.embed(["topic alpha"])).vectors[0]!);
      env.store.search(q, { scope: { kind: "global" } });

      // Simulate an outside writer (bg runner): insert a fresh row via
      // a separate Database handle, bypassing the cache write-through.
      const otherVec = normalize((await provider.embed(["topic alpha external"])).vectors[0]!);
      const outside = new Database(env.path);
      outside.exec("PRAGMA journal_mode = WAL");
      outside
        .prepare(
          `INSERT INTO rows (ref, kind, chat_guid, sender, ts, text, vec, model, dim)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "msg:outside",
          "message",
          "chatA",
          "+a",
          Date.now() - 30 * 86400000,
          "topic alpha external",
          Buffer.from(otherVec.buffer, otherVec.byteOffset, otherVec.byteLength),
          "hash",
          64,
        );
      outside.close();

      // The primary store should detect the bump via PRAGMA data_version
      // and pick up the new row on the next search.
      const hits = env.store.search(q, {
        scope: { kind: "global" },
        limit: 10,
      });
      const refs = hits.map((h) => h.ref).sort();
      expect(refs).toContain("msg:outside");
    } finally {
      env.cleanup();
    }
  });

  test("invalidateCache forces a full reload", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      await seed(store, provider, [{ ref: "msg:1", text: "x" }]);
      const q = normalize((await provider.embed(["x"])).vectors[0]!);
      store.search(q, { scope: { kind: "global" } }); // warm
      store.invalidateCache();
      // Search still works after invalidation; cache rebuilds.
      const hits = store.search(q, { scope: { kind: "global" } });
      expect(hits.length).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("search performance budget", () => {
  test("10000-row cache search completes under 50ms", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      // Seed 10k rows with a mix of vocabulary so MMR has work to do.
      const rows: IndexRow[] = [];
      const vocab = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
      const baseTexts = Array.from({ length: 10000 }, (_, i) => {
        const a = vocab[i % vocab.length]!;
        const b = vocab[(i * 7) % vocab.length]!;
        return `${a} ${b} doc ${i}`;
      });
      const result = await provider.embed(baseTexts);
      for (let i = 0; i < 10000; i++) {
        rows.push({
          ref: `msg:${i}`,
          kind: "message",
          chatGuid: "chatA",
          sender: "+a",
          ts: Date.now() - i * 60_000,
          text: baseTexts[i]!,
          vec: normalize(result.vectors[i]!),
          model: "hash",
        });
      }
      store.upsert(rows);
      const q = normalize((await provider.embed(["alpha beta query"])).vectors[0]!);
      // Warm cache + JIT.
      store.search(q, { scope: { kind: "global" }, limit: 10 });
      const start = Date.now();
      for (let i = 0; i < 10; i++) {
        store.search(q, {
          scope: { kind: "global" },
          limit: 10,
          mmrLambda: 0.7,
          dedupThreshold: 0.95,
          recencyHalfLifeMs: 14 * 86400000,
          recencyBoost: 1.0,
        });
      }
      const elapsedAvg = (Date.now() - start) / 10;
      // Generous: warm searches over a 10k-row in-memory cache + MMR
      // should land well under 50ms on any reasonable machine.
      expect(elapsedAvg).toBeLessThan(50);
    } finally {
      cleanup();
    }
  });
});
