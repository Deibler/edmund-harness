/**
 * Tests for context-aware boosting. The rationale: messages older than
 * the model's last compaction boundary aren't directly readable by the
 * model anymore (only the summary survives), so a relevant pre-compact
 * hit is *more valuable* than an equally-relevant post-compact hit
 * already sitting in context.
 *
 * `outsideContextBoost` multiplies the rank score for hits with
 * `ts < contextCutoffMs`. Tests verify the ordering, the disable
 * behavior, and that recency + context boosts stack sensibly.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRecall } from "../src/memory/auto-recall.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { type IndexRow, VectorStore, normalize } from "../src/memory/vector-store.ts";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "ctx-"));
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
  docs: Array<{ ref: string; text: string; ts: number }>,
): Promise<void> {
  const r = await provider.embed(docs.map((d) => d.text));
  const rows: IndexRow[] = docs.map((d, i) => ({
    ref: d.ref,
    kind: "message",
    chatGuid: "chatA",
    sender: "+a",
    ts: d.ts,
    text: d.text,
    vec: normalize(r.vectors[i]!),
    model: "hash",
  }));
  store.upsert(rows);
}

describe("VectorStore.search with contextCutoff + outsideContextBoost", () => {
  test("pre-cutoff hit ranks above post-cutoff hit with identical cosine", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      const cutoff = now - 10 * 86400000;
      await seed(store, provider, [
        { ref: "msg:pre", text: "exact same words here", ts: now - 30 * 86400000 },
        { ref: "msg:post", text: "exact same words here", ts: now - 1 * 86400000 },
      ]);
      const q = normalize((await provider.embed(["exact same words here"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "global" },
        limit: 10,
        contextCutoffMs: cutoff,
        outsideContextBoost: 1.0,
      });
      expect(hits[0]!.ref).toBe("msg:pre");
      expect(hits[1]!.ref).toBe("msg:post");
      expect(hits[0]!.rankScore).toBeGreaterThan(hits[1]!.rankScore);
      // Raw cosine is identical — only rankScore differs.
      expect(hits[0]!.score).toBeCloseTo(hits[1]!.score, 6);
    } finally {
      cleanup();
    }
  });

  test("boost=0 disables the bump (legacy ordering)", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      const cutoff = now - 10 * 86400000;
      await seed(store, provider, [
        { ref: "msg:pre", text: "shared topic", ts: now - 30 * 86400000 },
        { ref: "msg:post", text: "shared topic", ts: now - 1 * 86400000 },
      ]);
      const q = normalize((await provider.embed(["shared topic"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "global" },
        limit: 10,
        contextCutoffMs: cutoff,
        outsideContextBoost: 0,
      });
      // Without the boost both have identical score; sort is stable
      // enough that we just verify the rankScore equality, not ref
      // order.
      expect(hits[0]!.rankScore).toBeCloseTo(hits[1]!.rankScore, 6);
    } finally {
      cleanup();
    }
  });

  test("cutoff unset → no-op", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      await seed(store, provider, [
        { ref: "msg:a", text: "shared topic", ts: now - 30 * 86400000 },
      ]);
      const q = normalize((await provider.embed(["shared topic"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "global" },
        outsideContextBoost: 5.0, // big boost, but no cutoff = ignored
      });
      expect(hits[0]!.rankScore).toBeCloseTo(hits[0]!.score, 6);
    } finally {
      cleanup();
    }
  });

  test("stacks with recency boost (recent in-context, deep pre-cutoff both surface)", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      const cutoff = now - 10 * 86400000;
      await seed(store, provider, [
        // Pre-cutoff hit → gets the outside-context boost.
        { ref: "msg:deep", text: "shared topic", ts: now - 30 * 86400000 },
        // Post-cutoff hit → gets the recency boost instead.
        { ref: "msg:fresh", text: "shared topic", ts: now - 1 * 86400000 },
        // Very deep hit, well past cutoff — should also get boost but
        // recency penalizes it.
        { ref: "msg:ancient", text: "shared topic", ts: now - 365 * 86400000 },
      ]);
      const q = normalize((await provider.embed(["shared topic"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "global" },
        limit: 10,
        recencyHalfLifeMs: 14 * 86400000,
        recencyBoost: 1.0,
        contextCutoffMs: cutoff,
        outsideContextBoost: 1.0,
      });
      const refs = hits.map((h) => h.ref);
      // All three appear; ordering varies by exact math but the
      // pre-cutoff (msg:deep) should beat the ancient one (recency
      // decay swamps the context boost out at 365 days).
      const deepIdx = refs.indexOf("msg:deep");
      const ancientIdx = refs.indexOf("msg:ancient");
      expect(deepIdx).toBeGreaterThan(-1);
      expect(ancientIdx).toBeGreaterThan(-1);
      expect(deepIdx).toBeLessThan(ancientIdx);
    } finally {
      cleanup();
    }
  });
});

describe("autoRecall threads contextCutoff through to all blocks", () => {
  test("pre-cutoff message surfaces in deep block with boost", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      const cutoff = now - 35 * 86400000;
      await seed(store, provider, [
        // Pre-cutoff (deep): boosted.
        { ref: "msg:deep-boost", text: "specific topic", ts: now - 60 * 86400000 },
        // Pre-cutoff alt: same content, similar age.
        { ref: "msg:deep-similar", text: "specific topic alt", ts: now - 50 * 86400000 },
        // Post-cutoff (recent block).
        { ref: "msg:recent", text: "specific topic", ts: now - 5 * 86400000 },
      ]);
      const r = await autoRecall("specific topic", provider, store, {
        chatGuid: "chatA",
        limit: 5,
        minScore: 0.0,
        excludeRecentMs: 24 * 3_600_000,
        deepSplitDays: 30,
        deepLimit: 5,
        contextCutoffMs: cutoff,
        outsideContextBoost: 2.0,
      });
      const deepRefs = r.deep.map((h) => h.ref).sort();
      expect(deepRefs).toContain("msg:deep-boost");
      expect(r.recent.map((h) => h.ref)).toContain("msg:recent");
    } finally {
      cleanup();
    }
  });
});
