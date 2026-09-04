/**
 * Tests for the 3-tier group auto-recall + senderFilter on the vector
 * store. Validates that:
 *
 *  - VectorStore.search applies senderFilter alongside scope.
 *  - autoRecall returns three buckets in groups, with sender hits
 *    deduped out of the recent/deep blocks.
 *  - In DMs (no senderHandle) the sender block is empty.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRecall } from "../src/memory/auto-recall.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { type IndexRow, VectorStore, normalize } from "../src/memory/vector-store.ts";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "tier-"));
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
  docs: Array<{
    ref: string;
    text: string;
    ts: number;
    sender: string;
    chatGuid?: string;
  }>,
): Promise<void> {
  const r = await provider.embed(docs.map((d) => d.text));
  const rows: IndexRow[] = docs.map((d, i) => ({
    ref: d.ref,
    kind: "message",
    chatGuid: d.chatGuid ?? "chatA",
    sender: d.sender,
    ts: d.ts,
    text: d.text,
    vec: normalize(r.vectors[i]!),
    model: "hash",
  }));
  store.upsert(rows);
}

describe("VectorStore senderFilter", () => {
  test("filters to specified sender alongside this-chat scope", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const old = Date.now() - 60 * 86400000;
      await seed(store, provider, [
        { ref: "msg:jordan1", text: "shared topic", ts: old, sender: "+jordan" },
        { ref: "msg:jordan2", text: "shared topic", ts: old + 1, sender: "+jordan" },
        { ref: "msg:riley1", text: "shared topic", ts: old + 2, sender: "+riley" },
      ]);
      const q = normalize((await provider.embed(["shared topic"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "this-chat", chatGuid: "chatA" },
        senderFilter: "+jordan",
      });
      const refs = hits.map((h) => h.ref).sort();
      expect(refs).toEqual(["msg:jordan1", "msg:jordan2"]);
    } finally {
      cleanup();
    }
  });
});

describe("autoRecall tiered (group)", () => {
  test("returns senderInChat + recent + deep, with sender deduped from others", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const now = Date.now();
      const old = now - 60 * 86400000;
      const recentDate = now - 5 * 86400000;
      await seed(store, provider, [
        // Sender (jordan) hits — one recent, one deep.
        { ref: "msg:h-recent", text: "trail", ts: recentDate, sender: "+jordan" },
        { ref: "msg:h-deep", text: "trail", ts: old, sender: "+jordan" },
        // Other sender (riley) hits — one recent, one deep.
        { ref: "msg:k-recent", text: "trail", ts: recentDate + 1000, sender: "+riley" },
        { ref: "msg:k-deep", text: "trail", ts: old + 1000, sender: "+riley" },
      ]);
      const r = await autoRecall("trail", provider, store, {
        chatGuid: "chatA",
        limit: 5,
        minScore: 0.0,
        excludeRecentMs: 24 * 3_600_000,
        deepSplitDays: 30,
        deepLimit: 5,
        recencyHalfLifeMs: 14 * 86400000,
        recencyBoost: 1.0,
        senderHandle: "+jordan",
        senderLimit: 5,
      });
      const senderRefs = r.senderInChat.map((h) => h.ref).sort();
      const recentRefs = r.recent.map((h) => h.ref).sort();
      const deepRefs = r.deep.map((h) => h.ref).sort();
      expect(senderRefs).toEqual(["msg:h-deep", "msg:h-recent"]);
      // Sender hits should NOT appear in recent/deep blocks.
      expect(recentRefs).toEqual(["msg:k-recent"]);
      expect(deepRefs).toEqual(["msg:k-deep"]);
    } finally {
      cleanup();
    }
  });

  test("DM mode (no senderHandle) leaves sender block empty", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const old = Date.now() - 60 * 86400000;
      await seed(store, provider, [{ ref: "msg:1", text: "shared", ts: old, sender: "+jordan" }]);
      const r = await autoRecall("shared", provider, store, {
        chatGuid: "chatA",
        limit: 5,
        minScore: 0.0,
        excludeRecentMs: 0,
        deepSplitDays: 30,
        deepLimit: 5,
      });
      expect(r.senderInChat).toEqual([]);
      expect(r.senderInChatLines).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("senderLimit=0 disables sender block even when handle provided", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const old = Date.now() - 60 * 86400000;
      await seed(store, provider, [{ ref: "msg:1", text: "shared", ts: old, sender: "+jordan" }]);
      const r = await autoRecall("shared", provider, store, {
        chatGuid: "chatA",
        limit: 5,
        minScore: 0.0,
        excludeRecentMs: 0,
        deepSplitDays: 30,
        deepLimit: 5,
        senderHandle: "+jordan",
        senderLimit: 0,
      });
      expect(r.senderInChat).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
