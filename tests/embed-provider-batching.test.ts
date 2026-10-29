import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { INDEX_EMBED_BATCH, TransformersEmbedProvider } from "../src/memory/embed-provider.ts";

const workerUrl = new URL("./fixtures/fake-embed-worker.ts", import.meta.url);
let provider: TransformersEmbedProvider;

afterEach(() => provider?.trimIdleWorker());

const texts = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `text ${from + i}`);

describe("local embedding batches", () => {
  test("a large request reaches the model in small batches, in order", async () => {
    provider = new TransformersEmbedProvider("test-model", 2, workerUrl);
    const out = await provider.embed(texts(20));
    expect(out.vectors.length).toBe(20);
    expect(out.vectors.map((v) => v[1])).toEqual([...Array(20).keys()]);
    // The model never saw more than one index batch's worth at once, so a
    // query never waits long for the batch in flight.
    expect(Math.max(...out.vectors.map((v) => v[0] ?? 0))).toBeLessThanOrEqual(INDEX_EMBED_BATCH);
  });

  test("queries travel on the query lane, documents on the index lane", async () => {
    provider = new TransformersEmbedProvider("test-model", 2, workerUrl);
    expect((await provider.embedQuery(["query 7"])).vectors[0]![0]).toBeLessThan(0);
    expect((await provider.embed(["doc 7"])).vectors[0]![0]).toBeGreaterThan(0);
  });

  test("a live query does not wait for a whole backfill", async () => {
    provider = new TransformersEmbedProvider("test-model", 2, workerUrl);
    const done: string[] = [];
    const backfill = provider.embed(texts(48)).then(() => done.push("backfill"));
    await new Promise((resolve) => setTimeout(resolve, 1));
    const query = provider.embedQuery(["query 999"]).then((r) => {
      done.push("query");
      return r;
    });
    const [, answer] = await Promise.all([backfill, query]);
    expect(done).toEqual(["query", "backfill"]);
    expect(answer.vectors[0]?.[1]).toBe(999);
  });

  test("an idle worker lets the model go", async () => {
    provider = new TransformersEmbedProvider("test-model", 2, workerUrl, 30);
    await provider.embed(texts(2));
    await new Promise((resolve) => setTimeout(resolve, 120));
    // Nothing left to trim: the idle timer already released it.
    expect(provider.trimIdleWorker()).toBe(false);
    // And the next call simply starts a fresh worker.
    expect((await provider.embed(texts(1))).vectors.length).toBe(1);
  });

  test("an index batch stays small enough that a query barely waits for it", () => {
    // A running batch cannot be interrupted. Measured 2026-10-29: 41-45 ms per
    // person-file chunk at every batch size, so 8 held the worker for ~360 ms
    // idle (several times that under load) for no throughput gain over 2.
    expect(INDEX_EMBED_BATCH).toBeLessThanOrEqual(2);
  });

  test("warm loads a released model once, and is free while it is loaded", async () => {
    provider = new TransformersEmbedProvider("test-model", 2, workerUrl);
    expect(provider.trimIdleWorker()).toBe(false);
    provider.warm();
    provider.warm();
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The warm-up spawned the worker and finished, leaving it idle and loaded.
    expect(provider.trimIdleWorker()).toBe(true);
  });

  test("the daemon warms recall as a new turn's debounce opens", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/recall\.provider\?\.warm\?\.\(\);\s*pipeline\.enqueue\(key, msg\);/);
  });

  test("an idle worker is kept for a minute by default", () => {
    expect(TransformersEmbedProvider.WORKER_IDLE_MS).toBeLessThanOrEqual(60_000);
  });

  test("a request within one batch is one call", async () => {
    provider = new TransformersEmbedProvider("test-model", 2, workerUrl);
    const docs = await provider.embed(texts(INDEX_EMBED_BATCH));
    expect(docs.vectors.map((v) => v[0])).toEqual(Array(INDEX_EMBED_BATCH).fill(INDEX_EMBED_BATCH));
    // A query batch may be larger: queries are short and nothing waits on them.
    const queries = await provider.embedQuery(texts(3));
    expect(queries.vectors.map((v) => v[0])).toEqual([-3, -3, -3]);
  });
});
