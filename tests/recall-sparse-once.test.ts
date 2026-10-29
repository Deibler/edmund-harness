/**
 * Every auto-recall leg searched the same text with the same global BM25
 * query, so one recall ran it three times in a DM and four in a group, at
 * 63-175 ms each on the live index (2026-10-29). It runs once now and every
 * leg reuses the result.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRecall } from "../src/memory/auto-recall.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { VectorStore, normalize } from "../src/memory/vector-store.ts";

describe("auto-recall's BM25 lookup", () => {
  test("runs once per recall, whatever the number of legs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sparse-once-"));
    const store = new VectorStore(join(dir, "r.sqlite"));
    const provider = new HashEmbedProvider("h", 64);
    try {
      const day = 86_400_000;
      const docs = [
        { ref: "msg:1", ts: Date.now() - 2 * day, sender: "+15550100071" },
        { ref: "msg:2", ts: Date.now() - 40 * day, sender: "+15550100072" },
      ];
      const { vectors } = await provider.embed(docs.map(() => "pull station clear led dot"));
      store.upsert(
        docs.map((d, i) => ({
          ref: d.ref,
          kind: "message" as const,
          chatGuid: "chatA",
          sender: d.sender,
          ts: d.ts,
          text: "pull station clear led dot",
          vec: normalize(vectors[i]!),
          model: "hash",
        })),
      );
      const s = store as unknown as { sparseRefs: (q: string, n: number) => string[] };
      const real = s.sparseRefs.bind(store);
      let lookups = 0;
      s.sparseRefs = (q, n) => {
        lookups++;
        return real(q, n);
      };
      const r = await autoRecall("pull station clear led dot", provider, store, {
        chatGuid: "chatA",
        limit: 5,
        minScore: 0,
        excludeRecentMs: 0,
        deepSplitDays: 7,
        deepLimit: 5,
        senderHandle: "+15550100071",
        senderLimit: 3,
      });
      expect(r.recent.length + r.deep.length + r.senderInChat.length).toBeGreaterThan(0);
      expect(lookups).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
