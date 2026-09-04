/**
 * Unit tests for the semantic-recall vector store and the hash-based
 * test embedder. Exercises cosine ranking, scope filters, watermark
 * round-trip, and dim guard.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { type IndexRow, VectorStore, normalize } from "../src/memory/vector-store.ts";

function tempStore(): { store: VectorStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "recall-test-"));
  const store = new VectorStore(join(dir, "recall.sqlite"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function embed(text: string, dim = 64): Promise<Float32Array> {
  const r = await new HashEmbedProvider("hash", dim).embed([text]);
  return r.vectors[0]!;
}

function row(
  ref: string,
  text: string,
  vec: Float32Array,
  overrides: Partial<IndexRow> = {},
): IndexRow {
  return {
    ref,
    kind: "message",
    chatGuid: "chatA",
    sender: "alice",
    ts: Date.now(),
    text,
    vec,
    model: "hash",
    ...overrides,
  };
}

describe("VectorStore basics", () => {
  test("upsert + get round-trip", async () => {
    const { store, cleanup } = tempStore();
    try {
      const v = await embed("hello world");
      store.upsert([row("msg:1", "hello world", v)]);
      expect(store.hasRef("msg:1")).toBe(true);
      const fetched = store.get("msg:1");
      expect(fetched?.text).toBe("hello world");
      expect(fetched?.vec.length).toBe(64);
    } finally {
      cleanup();
    }
  });

  test("upsert replaces on same ref", async () => {
    const { store, cleanup } = tempStore();
    try {
      const v = await embed("v1");
      store.upsert([row("msg:1", "v1", v)]);
      store.upsert([row("msg:1", "v2", v)]);
      expect(store.get("msg:1")?.text).toBe("v2");
      expect(store.count()).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("FTS shadow replaces and deletes by ref", async () => {
    const { store, cleanup } = tempStore();
    try {
      const v = await embed("stable dense vector");
      const zero = new Float32Array(v.length);
      const sparse = (queryText: string) =>
        store.search(zero, {
          scope: { kind: "global" },
          queryText,
          // Exclude the zero-cosine dense leg so only FTS can admit a hit.
          minScore: 1,
        });

      store.upsert([row("msg:fts", "legacyzephyr token", v)]);
      expect(sparse("legacyzephyr").map((h) => h.ref)).toEqual(["msg:fts"]);

      store.upsert([row("msg:fts", "freshquokka token", v)]);
      expect(sparse("legacyzephyr")).toEqual([]);
      expect(sparse("freshquokka").map((h) => h.ref)).toEqual(["msg:fts"]);

      store.deleteRefs(["msg:fts"]);
      expect(sparse("freshquokka")).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("an FTS rebuild also repairs a same-sized stale rowid map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-test-"));
    const path = join(dir, "recall.sqlite");
    let store: VectorStore | null = new VectorStore(path);
    try {
      const v = await embed("stable dense vector");
      store.upsert([row("msg:one", "one oldtoken", v), row("msg:two", "two staytoken", v)]);
      store.close();
      store = null;

      const raw = new Database(path);
      raw.exec(`UPDATE rows_fts_refs SET fts_rowid = fts_rowid + 1000`);
      raw.exec(`DELETE FROM rows_fts WHERE rowid = (SELECT MIN(rowid) FROM rows_fts)`);
      raw.close();

      store = new VectorStore(path);
      store.upsert([row("msg:one", "one newtoken", v)]);

      const verify = new Database(path, { readonly: true });
      const mapped = verify
        .prepare<{ n: number }, []>(
          `SELECT COUNT(*) AS n
           FROM rows_fts_refs AS map
           JOIN rows_fts AS fts
             ON fts.rowid = map.fts_rowid AND fts.ref = map.ref`,
        )
        .get()?.n;
      const ftsCount = verify
        .prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM rows_fts`)
        .get()?.n;
      verify.close();
      expect(mapped).toBe(2);
      expect(ftsCount).toBe(2);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("watermark round-trip", () => {
    const { store, cleanup } = tempStore();
    try {
      expect(store.getWatermark("msg.rowid")).toBe(0);
      store.setWatermark("msg.rowid", 12345);
      expect(store.getWatermark("msg.rowid")).toBe(12345);
      store.setWatermark("msg.rowid", 99999);
      expect(store.getWatermark("msg.rowid")).toBe(99999);
    } finally {
      cleanup();
    }
  });
});

describe("VectorStore.search", () => {
  test("ranks by cosine similarity", async () => {
    const { store, cleanup } = tempStore();
    try {
      const docs = [
        ["msg:1", "the patio restaurant downtown was great"],
        ["msg:2", "weather is nice today"],
        ["msg:3", "we tried that restaurant with the patio last week"],
        ["msg:4", "I love hiking on weekends"],
      ] as const;
      const rows: IndexRow[] = [];
      for (const [ref, text] of docs) {
        const v = normalize(await embed(text));
        rows.push(row(ref, text, v));
      }
      store.upsert(rows);

      const q = normalize(await embed("which restaurant had the patio"));
      const hits = store.search(q, { scope: { kind: "global" }, limit: 4 });
      expect(hits.length).toBeGreaterThan(0);
      // The two restaurant-patio docs should rank above hiking/weather.
      const topRefs = hits
        .slice(0, 2)
        .map((h) => h.ref)
        .sort();
      expect(topRefs).toEqual(["msg:1", "msg:3"]);
    } finally {
      cleanup();
    }
  });

  test("this-chat scope filters by chat_guid", async () => {
    const { store, cleanup } = tempStore();
    try {
      const v = normalize(await embed("hello"));
      store.upsert([
        row("msg:a", "hello", v, { chatGuid: "chatA" }),
        row("msg:b", "hello", v, { chatGuid: "chatB" }),
      ]);
      const hits = store.search(v, {
        scope: { kind: "this-chat", chatGuid: "chatA" },
        limit: 10,
      });
      expect(hits.map((h) => h.ref)).toEqual(["msg:a"]);
    } finally {
      cleanup();
    }
  });

  test("person scope filters by sender", async () => {
    const { store, cleanup } = tempStore();
    try {
      const v = normalize(await embed("hello"));
      store.upsert([
        row("msg:a", "hello", v, { sender: "alice" }),
        row("msg:b", "hello", v, { sender: "bob" }),
      ]);
      const hits = store.search(v, {
        scope: { kind: "person", sender: "alice" },
        limit: 10,
      });
      expect(hits.map((h) => h.ref)).toEqual(["msg:a"]);
    } finally {
      cleanup();
    }
  });

  test("kind scope filters by row kind", async () => {
    const { store, cleanup } = tempStore();
    try {
      const v = normalize(await embed("hello"));
      store.upsert([
        row("msg:a", "hello", v, { kind: "message" }),
        row("person:a", "hello", v, {
          kind: "person-file",
          chatGuid: null,
          sender: null,
        }),
      ]);
      const hits = store.search(v, {
        scope: { kind: "kind", rowKind: "person-file" },
        limit: 10,
      });
      expect(hits.map((h) => h.ref)).toEqual(["person:a"]);
    } finally {
      cleanup();
    }
  });

  test("sinceMs filter excludes older rows", async () => {
    const { store, cleanup } = tempStore();
    try {
      const v = normalize(await embed("hello"));
      const now = Date.now();
      store.upsert([
        row("msg:old", "hello", v, { ts: now - 86400000 }),
        row("msg:new", "hello", v, { ts: now }),
      ]);
      const hits = store.search(v, {
        scope: { kind: "global" },
        sinceMs: now - 60_000,
      });
      expect(hits.map((h) => h.ref)).toEqual(["msg:new"]);
    } finally {
      cleanup();
    }
  });

  test("dim mismatch rows are excluded", async () => {
    const { store, cleanup } = tempStore();
    try {
      const v64 = normalize(await embed("hello", 64));
      const v32 = normalize(await embed("hello", 32));
      store.upsert([row("msg:64", "hello", v64)]);
      store.upsert([row("msg:32", "hello", v32)]);
      const hits = store.search(v64, { scope: { kind: "global" } });
      expect(hits.map((h) => h.ref)).toEqual(["msg:64"]);
    } finally {
      cleanup();
    }
  });

  test("minScore filters weak matches", async () => {
    const { store, cleanup } = tempStore();
    try {
      const a = normalize(await embed("apples and oranges"));
      const b = normalize(await embed("totally unrelated bicycle pedal"));
      store.upsert([row("msg:a", "apples and oranges", a)]);
      store.upsert([row("msg:b", "bicycle pedal", b)]);
      const q = normalize(await embed("apples and oranges"));
      const hits = store.search(q, {
        scope: { kind: "global" },
        minScore: 0.99,
      });
      expect(hits.length).toBe(1);
      expect(hits[0]!.ref).toBe("msg:a");
    } finally {
      cleanup();
    }
  });
});

describe("HashEmbedProvider", () => {
  test("returns unit vectors of requested dim", async () => {
    const p = new HashEmbedProvider("h", 32);
    const r = await p.embed(["hello world"]);
    expect(r.dim).toBe(32);
    expect(r.vectors[0]!.length).toBe(32);
    let n = 0;
    for (const x of r.vectors[0]!) n += x * x;
    expect(Math.sqrt(n)).toBeCloseTo(1, 5);
  });

  test("similar strings score higher than dissimilar", async () => {
    const p = new HashEmbedProvider("h", 64);
    const r = await p.embed([
      "let's go hiking saturday",
      "want to hike on saturday",
      "the price of tea in china",
    ]);
    const [a, b, c] = r.vectors;
    const dot = (u: Float32Array, v: Float32Array) => {
      let s = 0;
      for (let i = 0; i < u.length; i++) s += u[i]! * v[i]!;
      return s;
    };
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });
});
