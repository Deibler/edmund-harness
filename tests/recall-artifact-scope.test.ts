/**
 * Tests for artifact scoping + multi-kind coverage.
 *
 * The bug being prevented: artifacts written under a session sandbox
 * must carry the real iMessage chat.guid (the same value as the
 * message rows for that chat) — otherwise auto-recall's this-chat
 * filter never returns them.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { type IndexRow, VectorStore, normalize } from "../src/memory/vector-store.ts";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "art-"));
  const store = new VectorStore(join(dir, "r.sqlite"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("artifact rows scope under this-chat when chat_guid matches", () => {
  test("real-guid artifacts surface under this-chat scope", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const r = await provider.embed([
        "message body about pickup time",
        "[sandbox file: /sandbox/dm_X/notes.md] meeting notes about pickup time",
      ]);
      const real = "iMessage;-;+15550100001";
      const rows: IndexRow[] = [
        {
          ref: "msg:m1",
          kind: "message",
          chatGuid: real,
          sender: "+15550100001",
          ts: Date.now() - 30 * 86400000,
          text: "message body about pickup time",
          vec: normalize(r.vectors[0]!),
          model: "hash",
        },
        {
          ref: "artifact:/x/notes.md",
          kind: "artifact",
          chatGuid: real,
          sender: "me",
          ts: Date.now() - 5 * 86400000,
          text: "[sandbox file: /sandbox/dm_X/notes.md] meeting notes about pickup time",
          vec: normalize(r.vectors[1]!),
          model: "hash",
        },
      ];
      store.upsert(rows);
      const q = normalize((await provider.embed(["pickup time"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "this-chat", chatGuid: real },
        rowKinds: ["message", "artifact"],
        limit: 10,
      });
      const refs = hits.map((h) => h.ref).sort();
      expect(refs).toContain("msg:m1");
      expect(refs).toContain("artifact:/x/notes.md");
    } finally {
      cleanup();
    }
  });

  test("artifacts with the WRONG chat_guid don't leak into this-chat scope", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const r = await provider.embed([
        "shared topic with same wording",
        "[sandbox file: notes.md] shared topic with same wording",
      ]);
      const real = "iMessage;-;+1";
      const wrong = "dm_1"; // the buggy "use dirname as guid" value
      const rows: IndexRow[] = [
        {
          ref: "msg:m1",
          kind: "message",
          chatGuid: real,
          sender: "+1",
          ts: Date.now() - 30 * 86400000,
          text: "shared topic with same wording",
          vec: normalize(r.vectors[0]!),
          model: "hash",
        },
        {
          ref: "artifact:wrong-guid",
          kind: "artifact",
          chatGuid: wrong,
          sender: "me",
          ts: Date.now() - 5 * 86400000,
          text: "[sandbox file: notes.md] shared topic with same wording",
          vec: normalize(r.vectors[1]!),
          model: "hash",
        },
      ];
      store.upsert(rows);
      const q = normalize((await provider.embed(["shared topic"])).vectors[0]!);
      const hits = store.search(q, {
        scope: { kind: "this-chat", chatGuid: real },
        rowKinds: ["message", "artifact"],
      });
      // With the real-guid filter, the wrong-guid artifact must NOT
      // appear. Documents the invariant that the indexer's resolver
      // protects.
      expect(hits.map((h) => h.ref)).not.toContain("artifact:wrong-guid");
    } finally {
      cleanup();
    }
  });
});

describe("VectorStore.countByKind covers all kinds", () => {
  test("returns 0 for empty store of each kind", () => {
    const { store, cleanup } = tempStore();
    try {
      expect(store.countByKind("message")).toBe(0);
      expect(store.countByKind("artifact")).toBe(0);
      expect(store.countByKind("person-file")).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("counts each kind independently", async () => {
    const { store, cleanup } = tempStore();
    const provider = new HashEmbedProvider("h", 64);
    try {
      const r = await provider.embed(["m", "a", "p"]);
      store.upsert([
        {
          ref: "msg:1",
          kind: "message",
          chatGuid: "g",
          sender: "x",
          ts: 0,
          text: "m",
          vec: normalize(r.vectors[0]!),
          model: "h",
        },
        {
          ref: "art:1",
          kind: "artifact",
          chatGuid: "g",
          sender: "me",
          ts: 0,
          text: "a",
          vec: normalize(r.vectors[1]!),
          model: "h",
        },
        {
          ref: "person:1",
          kind: "person-file",
          chatGuid: null,
          sender: null,
          ts: 0,
          text: "p",
          vec: normalize(r.vectors[2]!),
          model: "h",
        },
      ]);
      expect(store.countByKind("message")).toBe(1);
      expect(store.countByKind("artifact")).toBe(1);
      expect(store.countByKind("person-file")).toBe(1);
    } finally {
      cleanup();
    }
  });
});
