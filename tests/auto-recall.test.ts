/**
 * Tests for the auto-recall helper. Uses the HashEmbedProvider and an
 * in-memory VectorStore (sqlite :memory:-ish — we use a temp file).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRecall, recallLogSegment } from "../src/memory/auto-recall.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { type IndexRow, VectorStore, normalize } from "../src/memory/vector-store.ts";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "auto-recall-"));
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
  docs: Array<{ ref: string; text: string; ts: number; chatGuid?: string; sender?: string }>,
): Promise<void> {
  const r = await provider.embed(docs.map((d) => d.text));
  const rows: IndexRow[] = docs.map((d, i) => ({
    ref: d.ref,
    kind: "message",
    chatGuid: d.chatGuid ?? "chatA",
    sender: d.sender ?? "alice",
    ts: d.ts,
    text: d.text,
    vec: normalize(r.vectors[i]!),
    model: "hash",
  }));
  store.upsert(rows);
}

describe("autoRecall", () => {
  test("returns top-N relevant older messages from this chat", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      const old = now - 30 * 86400000;
      await seed(store, provider, [
        { ref: "msg:1", text: "patio restaurant downtown", ts: old },
        { ref: "msg:2", text: "we tried the place with the patio last week", ts: old + 1000 },
        { ref: "msg:3", text: "totally unrelated topic about taxes", ts: old + 2000 },
      ]);

      const r = await autoRecall("which restaurant had the patio", provider, store, {
        chatGuid: "chatA",
        limit: 10,
        minScore: 0.1,
        excludeRecentMs: 24 * 3_600_000,
      });
      const refs = r.recent.map((h) => h.ref).sort();
      expect(refs).toContain("msg:1");
      expect(refs).toContain("msg:2");
      // Taxes msg may also score due to token collisions in hash embedder;
      // assert the patio ones rank highest.
      expect(r.recent[0]!.ref === "msg:1" || r.recent[0]!.ref === "msg:2").toBe(true);
    } finally {
      cleanup();
    }
  });

  test("excludes messages inside the recent window", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      await seed(store, provider, [
        { ref: "msg:old", text: "patio restaurant", ts: now - 30 * 86400000 },
        { ref: "msg:fresh", text: "patio restaurant", ts: now - 60_000 },
      ]);
      const r = await autoRecall("patio restaurant", provider, store, {
        chatGuid: "chatA",
        limit: 10,
        minScore: 0.1,
        excludeRecentMs: 24 * 3_600_000,
      });
      expect(r.recent.map((h) => h.ref)).toEqual(["msg:old"]);
    } finally {
      cleanup();
    }
  });

  test("excludeRefs filters hits", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      await seed(store, provider, [
        { ref: "msg:a", text: "topic", ts: now - 30 * 86400000 },
        { ref: "msg:b", text: "topic", ts: now - 30 * 86400000 },
      ]);
      const r = await autoRecall("topic", provider, store, {
        chatGuid: "chatA",
        limit: 10,
        minScore: 0.1,
        excludeRecentMs: 0,
        excludeRefs: new Set(["msg:a"]),
      });
      expect(r.recent.map((h) => h.ref)).toEqual(["msg:b"]);
    } finally {
      cleanup();
    }
  });

  test("respects limit", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      const docs = Array.from({ length: 5 }, (_, i) => ({
        ref: `msg:${i}`,
        text: `topic similar ${i}`,
        ts: now - 30 * 86400000 - i * 1000,
      }));
      await seed(store, provider, docs);
      const r = await autoRecall("topic similar", provider, store, {
        chatGuid: "chatA",
        limit: 3,
        minScore: 0.0,
        excludeRecentMs: 0,
      });
      expect(r.recent.length).toBeLessThanOrEqual(3);
    } finally {
      cleanup();
    }
  });

  test("ignores other chats", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now() - 30 * 86400000;
      await seed(store, provider, [
        { ref: "msg:a", text: "patio", ts: now, chatGuid: "chatA" },
        { ref: "msg:b", text: "patio", ts: now, chatGuid: "chatB" },
      ]);
      const r = await autoRecall("patio", provider, store, {
        chatGuid: "chatA",
        limit: 10,
        minScore: 0.0,
        excludeRecentMs: 0,
      });
      expect(r.recent.map((h) => h.ref)).toEqual(["msg:a"]);
    } finally {
      cleanup();
    }
  });

  test("returns empty on short query", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const r = await autoRecall("ok", provider, store, {
        chatGuid: "chatA",
        limit: 10,
        minScore: 0.0,
        excludeRecentMs: 0,
      });
      expect(r.recent).toEqual([]);
      expect(r.recentLines).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("swallows provider errors and returns empty", async () => {
    const { store, cleanup } = tempStore();
    const errProvider: HashEmbedProvider = {
      model: "x",
      dim: 64,
      embed: async () => {
        throw new Error("provider down");
      },
    } as unknown as HashEmbedProvider;
    try {
      const r = await autoRecall("some query here", errProvider, store, {
        chatGuid: "chatA",
        limit: 10,
        minScore: 0.0,
        excludeRecentMs: 0,
      });
      expect(r.recent).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("lines name the speaker as history does and drop the indexer's header", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const ts = Date.now() - 30 * 86400000;
      await seed(store, provider, [
        {
          ref: "msg:1",
          text: "[2026-09-29] +15550001111: the led dot prints clear",
          ts,
          sender: "+15550001111",
        },
        { ref: "msg:2", text: "[2026-09-29] me: clear dot it is", ts: ts + 1000, sender: "me" },
      ]);
      const r = await autoRecall("led dot clear", provider, store, {
        chatGuid: "chatA",
        limit: 5,
        minScore: 0.0,
        excludeRecentMs: 0,
        speakerLabel: (s) => (s === "me" ? "You" : s === "+15550001111" ? "Test Person" : s),
      });
      const lines = r.recentLines.join("\n");
      expect(lines).toContain("Test Person (");
      expect(lines).toContain("You (");
      expect(lines).toContain(": the led dot prints clear");
      expect(lines).not.toContain("[2026-09-29]");
      expect(lines).not.toContain("+15550001111");
    } finally {
      cleanup();
    }
  });

  test("lines preview is short and formatted", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const long = "patio ".repeat(80);
      await seed(store, provider, [
        { ref: "msg:1", text: long, ts: Date.now() - 30 * 86400000, sender: "alice" },
      ]);
      const r = await autoRecall("patio", provider, store, {
        chatGuid: "chatA",
        limit: 5,
        minScore: 0.0,
        excludeRecentMs: 0,
      });
      expect(r.recentLines.length).toBe(1);
      expect(r.recentLines[0]!.length).toBeLessThan(260);
      expect(r.recentLines[0]!).toContain("alice");
    } finally {
      cleanup();
    }
  });
});

describe("recall that could not run", () => {
  const opts = { chatGuid: "chatA", limit: 10, minScore: 0.1, excludeRecentMs: 0 };

  test("a broken embedder is reported, not passed off as nothing found", async () => {
    const { store, cleanup } = tempStore();
    try {
      const broken = new HashEmbedProvider(64);
      broken.embed = async () => {
        throw new Error("Cannot find module '@huggingface/transformers'");
      };
      const r = await autoRecall("which restaurant had the patio", broken, store, opts);
      // Still empty: a reply never waits on recall.
      expect(r.recent).toEqual([]);
      expect(r.recentLines).toEqual([]);
      expect(r.error).toContain("embed: Error: Cannot find module");
      expect(recallLogSegment(r, 0, [])).toBe("recall=ERR");
    } finally {
      cleanup();
    }
  });

  test("a search that fails is reported too", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider(64);
    store.close();
    try {
      const r = await autoRecall("which restaurant had the patio", provider, store, opts);
      expect(r.error).toStartWith("search: ");
      expect(recallLogSegment(r, 0, [])).toBe("recall=ERR");
    } finally {
      try {
        cleanup();
      } catch {}
    }
  });

  test("a message with no subject, and a search that found nothing, are not errors", async () => {
    const { store, cleanup } = tempStore();
    try {
      const provider = new HashEmbedProvider(64);
      const noSubject = await autoRecall("hi", provider, store, opts);
      expect(noSubject.error).toBeUndefined();
      expect(recallLogSegment(noSubject, 0, [])).toBe("");
      const nothing = await autoRecall("which restaurant had the patio", provider, store, opts);
      expect(nothing.error).toBeUndefined();
      expect(recallLogSegment({ embedMs: 3, searchMs: 12 }, 0, [])).toBe("recall=0 (3+12ms)");
    } finally {
      cleanup();
    }
  });

  test("hits are logged by lane", () => {
    expect(recallLogSegment({ embedMs: 4, searchMs: 96 }, 5, ["2s", "3r"])).toBe(
      "recall=5[2s/3r] (4+96ms)",
    );
  });
});
