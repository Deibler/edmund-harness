import { afterEach, describe, expect, test } from "bun:test";
import { LOCAL_EMBED_BATCH, TransformersEmbedProvider } from "../src/memory/embed-provider.ts";

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
    // The model never saw more than one batch's worth at once.
    expect(Math.max(...out.vectors.map((v) => v[0] ?? 0))).toBeLessThanOrEqual(LOCAL_EMBED_BATCH);
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

  test("a small request is one call", async () => {
    provider = new TransformersEmbedProvider("test-model", 2, workerUrl);
    const out = await provider.embed(texts(3));
    expect(out.vectors.map((v) => v[0])).toEqual([3, 3, 3]);
  });
});
