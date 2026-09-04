import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import type { Config } from "../../../src/config/config.ts";
import { VectorStore } from "../../../src/memory/vector-store.ts";
import type { RecallCoverage } from "../types.ts";

/**
 * Read-only window into the recall vector index. Indexing itself runs in
 * the daemon; the dashboard process opens the same SQLite file (WAL is
 * safe for concurrent readers) for stats. A reindex "kick" works by
 * touching a sentinel file the daemon's wire-recall loop polls.
 */
export function recallRoutes(deps: { config: Config; repoRoot: string }): Hono {
  const app = new Hono();
  const dataDir = deps.config.paths.data_dir;
  const dbPath = resolve(dataDir, deps.config.memory_recall.index_db);
  const kickPath = resolve(dataDir, "recall-reindex.kick");

  let store: VectorStore | null = null;
  function getStore(): VectorStore | null {
    if (store) return store;
    if (!existsSync(dbPath)) return null;
    try {
      store = new VectorStore(dbPath);
    } catch {
      store = null;
    }
    return store;
  }

  app.get("/", (c) => {
    const s = getStore();
    if (!s) {
      return c.json({
        coverage: null,
        config: deps.config.memory_recall,
        ready: false,
      });
    }
    const indexedMsgs = s.countByKind("message");
    const indexedArtifacts = s.countByKind("artifact");
    const indexedPeople = s.countByKind("person-file");
    const watermark = s.getWatermark("msg.rowid");
    const dbBytes = statSync(dbPath).size;
    const peopleDir = resolve(deps.repoRoot, "persona", "people");
    const totalPeople = existsSync(peopleDir)
      ? readdirSync(peopleDir).filter((f) => f.endsWith(".md")).length
      : 0;
    const coverage: RecallCoverage = {
      indexedMsgs,
      totalInWindow: indexedMsgs, // dashboard can't cheaply count chat.db window
      pendingMsgs: 0,
      indexedArtifacts,
      totalArtifacts: indexedArtifacts,
      indexedPeople,
      totalPeople,
      dbBytes,
      lastIndexedAtMs: existsSync(dbPath) ? statSync(dbPath).mtimeMs : null,
      reindexing: existsSync(kickPath),
    };
    return c.json({
      coverage,
      config: deps.config.memory_recall,
      ready: true,
      dbPath,
      watermarkMsgRowId: watermark,
    });
  });

  app.post("/reindex", (c) => {
    // Sentinel the daemon's wire-recall loop checks at each tick. The daemon
    // unlinks it once handled. The dashboard never reindexes directly to
    // avoid double-writer contention even though WAL would handle it.
    writeFileSync(kickPath, String(Date.now()));
    return c.json({ kicked: true, path: kickPath });
  });

  app.get("/by-session", (c) => {
    const s = getStore();
    if (!s) return c.json({ rows: [] });
    try {
      // biome-ignore lint/suspicious/noExplicitAny: read-through to bun:sqlite
      const db = (s as any).db as { query: (q: string) => { all: () => unknown[] } };
      const rows = db
        .query(
          "SELECT chat_guid, COUNT(*) AS n, MAX(ts) AS last_ts FROM rows WHERE kind='message' AND chat_guid IS NOT NULL GROUP BY chat_guid ORDER BY n DESC LIMIT 200",
        )
        .all() as Array<{ chat_guid: string; n: number; last_ts: number }>;
      return c.json({ rows });
    } catch {
      return c.json({ rows: [] });
    }
  });

  return app;
}
