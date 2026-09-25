/**
 * Regression tests for dependency trees in the sandbox walk.
 *
 * The bug being prevented (2026-09-04): the portal file list skipped
 * venv/site-packages/cadlib trees but the recall indexer did not, so 105k of
 * the index's 174k rows were vendored Python and the word "Testing" recalled
 * twenty sklearn specs. The skip list is now shared, and rows indexed before
 * the walk learned to skip are swept in bounded batches.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatDb } from "../src/imessage/db.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { Indexer, artifactPurgeKey, purgeDependencyArtifacts } from "../src/memory/indexer.ts";
import { type IndexRow, VectorStore } from "../src/memory/vector-store.ts";
import { DEPENDENCY_DIRS, underDependencyDir } from "../src/persona/sandbox.ts";

const chatDbStub = {
  query: () => ({
    all: () => [],
    get: () => ({ n: 0 }),
  }),
} as unknown as ChatDb;

const CHAT = "iMessage;-;+15550100001";

/** Paths a real sandbox grows: a Python venv, a vendored lib tree, an npm
 *  install. All must be invisible to the walk at any depth. */
const VENDORED = [
  "proj/venv/lib/python3.11/site-packages/sklearn/tests/test_pca.py",
  "proj/.venv/lib/python3.12/site-packages/numpy/testing.py",
  "proj/cadlib/sympy/core/tests/test_args.py",
  "proj/pylib/trimesh/intersections.py",
  "app/node_modules/react/index.js",
  "proj/__pycache__/leftover.py",
];

function fakeRow(ref: string): IndexRow {
  return {
    ref,
    kind: "artifact",
    chatGuid: CHAT,
    sender: "me",
    ts: 1,
    text: "vendored chunk",
    vec: new Float32Array(32).fill(1 / Math.sqrt(32)),
    model: "hash",
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "art-dep-"));
  const sandboxRoot = join(root, "sandbox");
  const sessionDir = join(sandboxRoot, "dm_test");
  mkdirSync(sessionDir, { recursive: true });
  const past = new Date(Date.now() - 60_000);
  const put = (rel: string, body: string): string => {
    const p = join(sessionDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    utimesSync(p, past, past);
    return p;
  };
  const store = new VectorStore(join(root, "recall.sqlite"));
  const provider = new HashEmbedProvider("hash", 32);
  store.resetIfModelChanged("hash", 32);
  const indexer = new Indexer(
    chatDbStub,
    store,
    provider,
    {
      maxChars: 2000,
      minChars: 1,
      batchSize: 64,
      chunkSize: 500,
      backfillDays: 0,
      sandboxRoot,
    },
    undefined,
    () => CHAT,
  );
  return {
    sessionDir,
    put,
    store,
    indexer,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("dependency trees in the sandbox", () => {
  test("the walk indexes authored files and nothing under a dependency tree", async () => {
    const { put, store, indexer, cleanup } = setup();
    try {
      put("proj/notes.md", "authored notes about the print");
      put("proj/build.py", "authored script that drives the printer");
      for (const rel of VENDORED) put(rel, `vendored ${rel}`);
      const t = await indexer.tick();
      expect(t.artifacts).toBe(2);
      const refs = store.refsWithPrefix("artifact:");
      expect(refs).toHaveLength(2);
      expect(refs.filter(underDependencyDir)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("rows indexed before the skip are swept in bounded batches, then never rescanned", async () => {
    const { sessionDir, put, store, indexer, cleanup } = setup();
    try {
      put("proj/notes.md", "authored notes");
      const keep = `artifact:${join(sessionDir, "proj/keep.md")}#0`;
      store.upsert(VENDORED.map((rel) => fakeRow(`artifact:${join(sessionDir, rel)}#0`)));
      store.upsert([fakeRow(keep)]);
      expect(store.countByKind("artifact")).toBe(VENDORED.length + 1);

      // A limit below the backlog deletes that many and leaves the sweep open.
      expect(purgeDependencyArtifacts(store, 2)).toBe(2);
      expect(store.getWatermarkString("artifact.dependency_purge")).toBeNull();

      // The next tick finishes it and records the list it swept for.
      await indexer.tick();
      const refs = store.refsWithPrefix("artifact:");
      expect(refs.filter(underDependencyDir)).toEqual([]);
      expect(refs).toContain(keep);
      expect(store.getWatermarkString("artifact.dependency_purge")).toBe(artifactPurgeKey());
      expect(artifactPurgeKey()).toContain([...DEPENDENCY_DIRS].sort().join(","));
      expect(purgeDependencyArtifacts(store)).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("a heartbeat file the kitchen drain rewrites every pass is never indexed", async () => {
    const { sessionDir, put, store, indexer, cleanup } = setup();
    try {
      put("artifact_site/index.md", "the household's kitchen page notes");
      put("artifact_site/pending.json", '{"at":"2026-09-24T22:13:00Z","waiting":[]}');
      // Indexed by the old walk, before it learned to skip the file.
      const old = `artifact:${join(sessionDir, "other/pending.json")}#0`;
      store.upsert([fakeRow(old)]);
      const t = await indexer.tick();
      expect(t.artifacts).toBe(1);
      const refs = store.refsWithPrefix("artifact:");
      expect(refs).toEqual([`artifact:${join(sessionDir, "artifact_site/index.md")}#0`]);
      // Rewritten again: still nothing to embed.
      put("artifact_site/pending.json", '{"at":"2026-09-24T22:14:00Z","waiting":[]}');
      expect((await indexer.tick()).artifacts).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("extending the skip list re-runs the sweep: keyed on content, not a version", () => {
    const { store, cleanup } = setup();
    try {
      store.setWatermarkString("artifact.dependency_purge", "node_modules");
      store.upsert([fakeRow("artifact:/sandbox/dm_test/proj/venv/lib/a.py#0")]);
      expect(purgeDependencyArtifacts(store)).toBe(1);
      expect(store.countByKind("artifact")).toBe(0);
    } finally {
      cleanup();
    }
  });
});
