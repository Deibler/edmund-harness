/**
 * MMR weighs relevance against similarity, so the two must share a scale.
 * Every auto-recall leg passes its query text, and the sparse fusion then
 * hands MMR an RRF score (at most ~0.033) as relevance against a cosine
 * similarity (0–1). Until 2026-10-29, 0.3·similarity outweighed
 * 0.7·relevance about twentyfold, so after the first pick recall chose the
 * hit least like the ones before it, not the next most relevant. Replaying
 * 41 labelled questions from the operator's DM, fixing the scale reached one more
 * needed message under either recall boundary and lost none.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { type IndexRow, VectorStore, normalize } from "../src/memory/vector-store.ts";

describe("MMR on the fused ranking", () => {
  test("the second pick is the next most relevant, not merely the least similar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mmr-scale-"));
    const store = new VectorStore(join(dir, "r.sqlite"));
    try {
      const provider = new HashEmbedProvider("h", 256);
      const docs = [
        { ref: "msg:A", text: "pull station led dot prints in clear pla" },
        { ref: "msg:B", text: "pull station led dot clear reprint tonight" },
        { ref: "msg:C", text: "crockpot kielbasa potatoes dinner" },
      ];
      const { vectors } = await provider.embed(docs.map((d) => d.text));
      store.upsert(
        docs.map(
          (d, i): IndexRow => ({
            ref: d.ref,
            kind: "message",
            chatGuid: "chatA",
            sender: "+15550000001",
            ts: Date.now() - 86_400_000,
            text: d.text,
            vec: normalize(vectors[i]!),
            model: "hash",
          }),
        ),
      );
      const q = await provider.embed(["pull station led dot prints in clear pla"]);
      const hits = store.search(normalize(q.vectors[0]!), {
        scope: { kind: "this-chat", chatGuid: "chatA" },
        queryText: "pull station led dot prints in clear pla",
        sparseRescue: false,
        limit: 2,
        minScore: -1,
        mmrLambda: 0.7,
        dedupThreshold: 0.99,
      });
      expect(hits.map((h) => h.ref)).toEqual(["msg:A", "msg:B"]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
