/**
 * Vector store for semantic recall. Backed by bun:sqlite — vectors are
 * stored as Float32 BLOBs, similarity is computed in JS via cosine
 * (vectors are inserted pre-normalized so it reduces to a dot product).
 *
 * No sqlite-vec dependency: full-scan cosine is fine up to several
 * hundred thousand rows for an iMessage-volume index. If/when the
 * store grows past that, swap the search() inner loop for sqlite-vec.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** `self-file` is SOUL.md and its archive — Edmund's notes about himself.
 *  Unlike `person-file` it is NOT scoped to a chat: it is relevant in every
 *  conversation, so its rows carry a null chat_guid and reach recall through
 *  the global pass. */
/**
 * `skill` rows hold one skill's name + description — the same catalogue line
 * the model reads. Indexed so the RIGHT skill can be surfaced at the moment
 * of intent, instead of relying on the model to think of calling list_skills.
 * Measured over four months: skills were read on ~5% of turns, and 82% of
 * those reads were the four skills the system prompt names explicitly.
 * Discovery was not happening on its own.
 */
export type RowKind = "message" | "person-file" | "artifact" | "summary" | "self-file" | "skill";

export type IndexRow = {
  /** Stable identifier for the row's source (e.g. `msg:<guid>`, `person:<handle>`, `artifact:<path>`). */
  ref: string;
  kind: RowKind;
  /** iMessage chat.guid for scope filtering; null for non-message rows. */
  chatGuid: string | null;
  /** Sender handle for scope filtering; null for non-message rows. */
  sender: string | null;
  /** Unix ms — message date, file mtime, etc. */
  ts: number;
  /** Pre-truncated text the model will see in the result. */
  text: string;
  /** Pre-normalized embedding (unit length). */
  vec: Float32Array;
  /** Model id that produced the vector. */
  model: string;
};

export type SearchScope =
  | { kind: "this-chat"; chatGuid: string }
  | { kind: "global" }
  | { kind: "person"; sender: string }
  | { kind: "kind"; rowKind: RowKind };

export type SearchOptions = {
  scope: SearchScope;
  /** Inclusive lower bound on ts (unix ms). */
  sinceMs?: number;
  /** Inclusive upper bound on ts (unix ms). Useful for "deep memory"
   *  queries that want only messages older than N days. */
  untilMs?: number;
  /** Restrict to one row kind even within scope (default: all kinds). */
  rowKinds?: RowKind[];
  /** Additional filter on sender. Combined with `scope` via AND — used
   *  to narrow a this-chat search to a specific participant in groups
   *  ("what has Jordan said in this group about X"). */
  senderFilter?: string;
  /** Max results returned. */
  limit?: number;
  /** Min cosine score in [-1, 1] before a row is included. */
  minScore?: number;
  /**
   * Temporal weighting. When set, ranking score becomes
   *   cosine * (1 + recencyBoost * exp(-age_ms / recencyHalfLifeMs))
   * where age_ms = nowMs - ts. Both fields must be set together;
   * unset means no weighting (raw cosine). The original cosine score
   * is preserved on each `SearchHit` as `score` — the boosted figure
   * is exposed as `rankScore`.
   */
  recencyHalfLifeMs?: number;
  recencyBoost?: number;
  /** Override of "now" for deterministic tests. */
  nowMs?: number;
  /**
   * Maximal Marginal Relevance reranking. After cosine ranking, picks
   * are made greedily to balance relevance to the query AND novelty vs.
   * already-picked hits. `mmrLambda` in [0, 1]: 1 = pure relevance
   * (no diversity), 0 = pure diversity. Defaults to no reranking
   * (returns whatever `limit` rows scored highest by cosine/recency).
   */
  mmrLambda?: number;
  /**
   * Hard de-duplication threshold. Two hits whose pairwise cosine is
   * ≥ this value are treated as near-duplicates — the lower-scoring
   * one is dropped from the result set. Applied after MMR if both are
   * set. Range [0, 1].
   */
  dedupThreshold?: number;
  /**
   * Context-window cutoff (unix ms). Messages older than this fall
   * outside the model's directly-readable context — for the daemon,
   * that's the `last_compact_at_ms` boundary. Hits older than the
   * cutoff get an additional multiplicative boost via
   * `outsideContextBoost`, surfacing content the model otherwise
   * couldn't see except through a summary.
   */
  contextCutoffMs?: number;
  /**
   * Strength of the outside-context boost. Combined as
   *   rankScore *= (1 + outsideContextBoost) when ts < contextCutoffMs.
   * 0 = disabled. 1.0 = pre-cutoff hits get up to 2× the same-cosine
   * post-cutoff hit. Stacks multiplicatively with the recency boost,
   * but the two operate on opposite ends of the timeline so they
   * don't fight each other in practice.
   */
  outsideContextBoost?: number;
  /**
   * Raw query TEXT for the sparse (BM25/FTS5) leg of hybrid search.
   * When set, dense and sparse candidate lists are fused with
   * Reciprocal Rank Fusion (k=60) before the MMR/dedup pipeline —
   * BM25 rescues exact names, numbers, and rare terms that dense
   * vectors miss; dense rescues paraphrases BM25 can't see. A hit
   * below `minScore` on cosine survives only if the sparse leg
   * independently ranked it. Unset = pure dense (legacy behavior).
   */
  queryText?: string;
};

export type SearchHit = {
  ref: string;
  kind: RowKind;
  chatGuid: string | null;
  sender: string | null;
  ts: number;
  text: string;
  /** Raw cosine score in [-1, 1] — never modified by recency. */
  score: number;
  /** Ranking score actually used to order results. Equals `score` when
   *  no recency weighting was applied; otherwise `score * (1 + boost *
   *  exp(-age/halfLife))`. */
  rankScore: number;
};

/**
 * In-memory cache row. Mirrors the SQLite row but with the vec already
 * decoded into a Float32Array — saves a Buffer→Float32Array conversion
 * per query, which was the dominant cost on hot searches.
 */
type CacheRow = {
  ref: string;
  kind: RowKind;
  chatGuid: string | null;
  sender: string | null;
  ts: number;
  text: string;
  vec: Float32Array;
  dim: number;
};

export class VectorStore {
  private db: Database;
  private cacheIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Lazy in-memory cache of all rows. Populated on first search and
   * kept in sync by `upsert`. Halves search latency on warm queries
   * (no SQL fetch, no BLOB decode). Memory cost is bounded: 384 floats
   * × 4 bytes × N rows ≈ 1.5KB per row, so a 100k-row index = 150MB.
   *
   * Cross-process consistency: bg-runner writes to the same SQLite
   * DB but doesn't share this Map. Before every search we check
   * `PRAGMA data_version`; if any other connection has written since
   * our last reload, we pull deltas (rows with rowid above our
   * watermark) into the cache. Same-process writes go through
   * `upsert` and update the cache write-through — no extra read.
   */
  private cache: Map<string, CacheRow> | null = null;
  /** SQLite rowid watermark for the cache. Used for incremental delta loads. */
  private cacheRowidWatermark = 0;
  /** Last seen `PRAGMA data_version` value. Bumps when *other*
   *  connections write. Lets us detect cross-process changes cheaply. */
  private cacheDataVersion = 0;

  constructor(
    private path: string,
    private readonly cacheIdleMs = 10 * 60_000,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rows (
        ref       TEXT PRIMARY KEY,
        kind      TEXT NOT NULL,
        chat_guid TEXT,
        sender    TEXT,
        ts        INTEGER NOT NULL,
        text      TEXT NOT NULL,
        vec       BLOB NOT NULL,
        model     TEXT NOT NULL,
        dim       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rows_kind_ts ON rows(kind, ts);
      CREATE INDEX IF NOT EXISTS rows_chat    ON rows(chat_guid);
      CREATE INDEX IF NOT EXISTS rows_sender  ON rows(sender);

      CREATE TABLE IF NOT EXISTS watermarks (
        key       TEXT PRIMARY KEY,
        value     INTEGER NOT NULL,
        updated   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watermark_strings (
        key     TEXT PRIMARY KEY,
        value   TEXT NOT NULL,
        updated INTEGER NOT NULL
      );
    `);
    // Sparse leg of hybrid search: an FTS5 shadow of (ref, text). BM25
    // catches exact names/numbers/rare terms that a 384-dim dense vector
    // reliably misses; fusing the two beats either alone in every category
    // measured on conversational memory (see docs/research/
    // memory-architecture-2026-07-28.md, report 3).
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS rows_fts
       USING fts5(ref UNINDEXED, text, tokenize='porter unicode61')`,
    );
    // FTS deliberately leaves `ref` unindexed, because it is metadata rather
    // than searchable text. Do not consequently locate a shadow row with
    // `WHERE ref = ?`: that is a full scan of the entire FTS table for every
    // upsert. The ordinary table below gives each ref an indexed route to the
    // FTS rowid, turning updates/deletes back into point lookups.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rows_fts_refs (
        ref       TEXT PRIMARY KEY,
        fts_rowid INTEGER UNIQUE NOT NULL
      );
    `);

    // One-time backfill for stores created before the FTS table or rowid map
    // existed. If counts ever diverge, rebuild both shadows from the canonical
    // rows table rather than preserving an orphan or duplicate FTS entry.
    let ftsCount =
      this.db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM rows_fts`).get()?.n ?? 0;
    const rowCount =
      this.db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM rows`).get()?.n ?? 0;
    let rebuiltFts = false;
    if (ftsCount !== rowCount) {
      this.db.exec(`DELETE FROM rows_fts`);
      this.db.exec(`INSERT INTO rows_fts (ref, text) SELECT ref, text FROM rows`);
      ftsCount = rowCount;
      rebuiltFts = true;
    }
    const mappedCount =
      this.db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM rows_fts_refs`).get()?.n ?? 0;
    // A full FTS rebuild can assign different rowids even when the old map
    // happened to have the same number of entries. Refresh it unconditionally
    // in that case so a later point update cannot target the wrong document.
    if (rebuiltFts || mappedCount !== ftsCount) {
      this.db.exec(`
        DELETE FROM rows_fts_refs;
        INSERT INTO rows_fts_refs (ref, fts_rowid)
        SELECT ref, rowid FROM rows_fts;
      `);
    }
  }

  close(): void {
    this.invalidateCache();
    this.db.close();
  }

  /**
   * Ensure the cache is current. Three phases:
   *
   *  1. Cold (no cache yet): full load. Slow first call (~10-50ms for
   *     a 20k-row index), but it pays for itself on every subsequent
   *     search.
   *  2. Warm + same data_version: cache is good, do nothing.
   *  3. Warm + bumped data_version: another connection wrote.
   *     Incrementally pull rows with rowid > our watermark and merge.
   *
   * This is what guarantees "new messages get new searches" — the bg
   * runner can insert a row from another process, and the very next
   * search in the daemon picks it up.
   */
  private ensureCache(): Map<string, CacheRow> {
    if (!this.cache) {
      this.cache = new Map();
      this.cacheRowidWatermark = 0;
      this.refreshCacheFromRowid();
      this.cacheDataVersion = this.readDataVersion();
      return this.cache;
    }
    const currentVersion = this.readDataVersion();
    if (currentVersion !== this.cacheDataVersion) {
      this.refreshCacheFromRowid();
      this.cacheDataVersion = currentVersion;
    }
    return this.cache;
  }

  private readDataVersion(): number {
    const row = this.db.prepare<{ data_version: number }, []>(`PRAGMA data_version`).get();
    return row?.data_version ?? 0;
  }

  /**
   * Pull every row with `rowid > cacheRowidWatermark` into the cache.
   * Initial load (watermark=0) reads everything; incremental loads
   * read only rows committed since the last refresh. Watermark is the
   * MAX rowid we saw after this scan.
   */
  private refreshCacheFromRowid(): void {
    if (!this.cache) return;
    const rows = this.db
      .prepare<DbRow & { rowid: number }, [number]>(
        `SELECT rowid AS rowid, ref, kind, chat_guid, sender, ts, text, vec, model, dim
         FROM rows WHERE rowid > ?`,
      )
      .all(this.cacheRowidWatermark);
    let maxRowid = this.cacheRowidWatermark;
    for (const r of rows) {
      if (r.rowid > maxRowid) maxRowid = r.rowid;
      const vec = new Float32Array(r.dim);
      const src = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dim);
      vec.set(src);
      this.cache.set(r.ref, {
        ref: r.ref,
        kind: r.kind as RowKind,
        chatGuid: r.chat_guid,
        sender: r.sender,
        ts: r.ts,
        text: r.text,
        vec,
        dim: r.dim,
      });
    }
    this.cacheRowidWatermark = maxRowid;
  }

  /** Drop the cache. Used by resetIfModelChanged so dim-mismatched
   *  rows don't linger in memory after a model swap. */
  invalidateCache(): void {
    if (this.cacheIdleTimer) clearTimeout(this.cacheIdleTimer);
    this.cacheIdleTimer = null;
    this.cache = null;
    this.cacheRowidWatermark = 0;
    this.cacheDataVersion = 0;
  }

  /** A hot semantic-search cache is valuable during an active conversation,
   * but every resident MCP worker otherwise holds ~150 MB indefinitely. Drop
   * it after a quiet period; the next search reloads it transparently. */
  private armCacheIdleEviction(): void {
    if (this.cacheIdleMs <= 0) return;
    if (this.cacheIdleTimer) clearTimeout(this.cacheIdleTimer);
    const timer = setTimeout(() => {
      if (this.cacheIdleTimer !== timer) return;
      this.cacheIdleTimer = null;
      this.cache = null;
      this.cacheRowidWatermark = 0;
      this.cacheDataVersion = 0;
    }, this.cacheIdleMs);
    timer.unref?.();
    this.cacheIdleTimer = timer;
  }

  /** Insert or replace a batch of rows. Vectors must all share the same dim. */
  upsert(rows: IndexRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO rows
       (ref, kind, chat_guid, sender, ts, text, vec, model, dim)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ftsRowid = this.db.prepare<{ fts_rowid: number }, [string]>(
      `SELECT fts_rowid FROM rows_fts_refs WHERE ref = ?`,
    );
    const ftsDelete = this.db.prepare(`DELETE FROM rows_fts WHERE rowid = ?`);
    const ftsInsertAt = this.db.prepare(`INSERT INTO rows_fts (rowid, ref, text) VALUES (?, ?, ?)`);
    const ftsInsert = this.db.prepare(`INSERT INTO rows_fts (ref, text) VALUES (?, ?)`);
    const mapFts = this.db.prepare(`INSERT INTO rows_fts_refs (ref, fts_rowid) VALUES (?, ?)`);
    const insert = this.db.transaction((batch: IndexRow[]) => {
      for (const r of batch) {
        stmt.run(
          r.ref,
          r.kind,
          r.chatGuid,
          r.sender,
          r.ts,
          r.text,
          // Buffer.from on the underlying ArrayBuffer
          Buffer.from(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength),
          r.model,
          r.vec.length,
        );
        const mapped = ftsRowid.get(r.ref);
        if (mapped) {
          // Reuse the rowid so the mapping itself never churns. Both
          // statements are indexed by the FTS integer primary key.
          ftsDelete.run(mapped.fts_rowid);
          ftsInsertAt.run(mapped.fts_rowid, r.ref, r.text);
        } else {
          const inserted = ftsInsert.run(r.ref, r.text);
          mapFts.run(r.ref, Number(inserted.lastInsertRowid));
        }
      }
    });
    insert(rows);
    // Write-through to the cache so a warm search after upsert sees
    // the new rows without paying a full reload. Each cache row owns
    // its own Float32Array copy.
    if (this.cache) {
      for (const r of rows) {
        const copy = new Float32Array(r.vec.length);
        copy.set(r.vec);
        this.cache.set(r.ref, {
          ref: r.ref,
          kind: r.kind,
          chatGuid: r.chatGuid,
          sender: r.sender,
          ts: r.ts,
          text: r.text,
          vec: copy,
          dim: r.vec.length,
        });
      }
    }
  }

  /** Look up one row by ref (mostly for tests). */
  get(ref: string): IndexRow | null {
    const row = this.db
      .prepare<DbRow, [string]>(
        `SELECT ref, kind, chat_guid, sender, ts, text, vec, model, dim FROM rows WHERE ref = ?`,
      )
      .get(ref);
    if (!row) return null;
    return rowToIndexRow(row);
  }

  /**
   * Cosine-similarity search. Iterates the in-memory cache (lazy-loaded
   * + delta-refreshed when other connections write), applies the
   * SQL-equivalent filters in code, scores via dot product (vectors are
   * pre-normalized so cosine = dot), optionally reranks with MMR to
   * diversify hits, and returns the top-N results.
   *
   * The hot path is now O(N) over the cache map — no SQL fetch, no
   * BLOB decode. For a 20k-row index this completes in 1-3 ms.
   */
  search(qvec: Float32Array, opts: SearchOptions): SearchHit[] {
    const cache = this.ensureCache();
    this.armCacheIdleEviction();
    const limit = opts.limit ?? 20;
    const minScore = opts.minScore ?? Number.NEGATIVE_INFINITY;
    const useRecency =
      typeof opts.recencyHalfLifeMs === "number" &&
      typeof opts.recencyBoost === "number" &&
      opts.recencyHalfLifeMs > 0;
    const halfLife = opts.recencyHalfLifeMs ?? 1;
    const boost = opts.recencyBoost ?? 0;
    const now = opts.nowMs ?? Date.now();
    const useContextBoost =
      typeof opts.contextCutoffMs === "number" &&
      opts.contextCutoffMs > 0 &&
      typeof opts.outsideContextBoost === "number" &&
      opts.outsideContextBoost > 0;
    const contextCutoff = opts.contextCutoffMs ?? 0;
    const contextBoost = opts.outsideContextBoost ?? 0;
    const rowKindSet = opts.rowKinds && opts.rowKinds.length > 0 ? new Set(opts.rowKinds) : null;

    // Score every candidate that passes the cheap filters. We over-fetch
    // (5× the limit, capped at 300) so MMR has a healthy pool to
    // diversify across; pure cosine ranking would otherwise lock us into
    // near-duplicates. Rows below minScore are scored but tagged — the
    // sparse leg of hybrid search may still rescue them.
    const scored = new Map<string, SearchHit>();
    for (const r of cache.values()) {
      if (r.dim !== qvec.length) continue;
      if (!passesFilters(r, opts, rowKindSet)) continue;

      // Dot product. Vectors are unit-length so dot = cosine.
      const v = r.vec;
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += qvec[i]! * v[i]!;

      let rankScore = dot;
      if (useRecency) {
        const ageMs = Math.max(0, now - r.ts);
        const recency = Math.exp(-ageMs / halfLife);
        rankScore = dot * (1 + boost * recency);
      }
      if (useContextBoost && r.ts < contextCutoff) {
        // Outside the model's direct context window — surfacing this
        // hit is the most valuable thing recall can do.
        rankScore = rankScore * (1 + contextBoost);
      }
      scored.set(r.ref, {
        ref: r.ref,
        kind: r.kind,
        chatGuid: r.chatGuid,
        sender: r.sender,
        ts: r.ts,
        text: r.text,
        score: dot,
        rankScore,
      });
    }

    const dense = [...scored.values()].filter((h) => h.score >= minScore);
    dense.sort((a, b) => b.rankScore - a.rankScore);

    let pool: SearchHit[];
    if (opts.queryText) {
      pool = fuseWithSparse(dense, scored, this.sparseRefs(opts.queryText, 200), limit);
    } else {
      pool = dense;
    }

    const poolSize = Math.min(pool.length, Math.max(limit * 5, limit + 20, 50));
    const candidates = pool.slice(0, poolSize);

    // No MMR + no dedup → fast path, the existing behavior.
    const lambda = opts.mmrLambda;
    const dedupAt = opts.dedupThreshold;
    if (lambda === undefined && dedupAt === undefined) {
      return candidates.slice(0, limit);
    }

    return rerankForDiversity(candidates, cache, qvec, limit, lambda, dedupAt);
  }

  /**
   * BM25 candidates from the FTS5 shadow, best first. The MATCH query is
   * built from bare word tokens OR-ed together (quoted), so user text
   * can never inject FTS5 syntax. Returns refs only — filtering and
   * fusion happen against the scored cache rows.
   */
  private sparseRefs(queryText: string, limit: number): string[] {
    const tokens = [
      ...new Set((queryText.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).slice(0, 12)),
    ];
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t}"`).join(" OR ");
    try {
      const rows = this.db
        .prepare<{ ref: string }, [string, number]>(
          `SELECT ref FROM rows_fts WHERE rows_fts MATCH ? ORDER BY bm25(rows_fts) LIMIT ?`,
        )
        .all(match, limit);
      return rows.map((r) => r.ref);
    } catch {
      // A pathological token slipping past the sanitizer must degrade to
      // dense-only, not break search.
      return [];
    }
  }

  hasRef(ref: string): boolean {
    const row = this.db
      .prepare<{ n: number }, [string]>(`SELECT 1 AS n FROM rows WHERE ref = ? LIMIT 1`)
      .get(ref);
    return !!row;
  }

  /** All refs starting with a prefix — used to prune stale chunk rows
   *  when a re-chunked document shrinks. `%`/`_` in the prefix are
   *  escaped so file-path refs can't act as wildcards. */
  refsWithPrefix(prefix: string): string[] {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db
      .prepare<{ ref: string }, [string]>(`SELECT ref FROM rows WHERE ref LIKE ? ESCAPE '\\'`)
      .all(`${escaped}%`);
    return rows.map((r) => r.ref);
  }

  /** Delete rows (and their FTS shadows + cache entries) by ref. */
  deleteRefs(refs: string[]): void {
    if (refs.length === 0) return;
    const delRow = this.db.prepare(`DELETE FROM rows WHERE ref = ?`);
    const delFts = this.db.prepare(
      `DELETE FROM rows_fts
       WHERE rowid = (SELECT fts_rowid FROM rows_fts_refs WHERE ref = ?)`,
    );
    const delFtsRef = this.db.prepare(`DELETE FROM rows_fts_refs WHERE ref = ?`);
    const run = this.db.transaction((batch: string[]) => {
      for (const ref of batch) {
        delFts.run(ref);
        delFtsRef.run(ref);
        delRow.run(ref);
      }
    });
    run(refs);
    if (this.cache) for (const ref of refs) this.cache.delete(ref);
  }

  getWatermark(key: string): number {
    const row = this.db
      .prepare<{ value: number }, [string]>(`SELECT value FROM watermarks WHERE key = ?`)
      .get(key);
    return row?.value ?? 0;
  }

  setWatermark(key: string, value: number): void {
    this.db
      .prepare(
        `INSERT INTO watermarks (key, value, updated) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated`,
      )
      .run(key, value, Date.now());
  }

  /** Row count (for diagnostics + the dashboard). */
  count(): number {
    const row = this.db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM rows`).get();
    return row?.n ?? 0;
  }

  /** Count of rows of a specific kind. Cheap (indexed). */
  countByKind(kind: RowKind): number {
    const row = this.db
      .prepare<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM rows WHERE kind = ?`)
      .get(kind);
    return row?.n ?? 0;
  }

  /**
   * Count of distinct DOCUMENTS of a kind whose rows are chunked
   * (`<prefix>#<seq>` refs). Chunking made countByKind a chunk count;
   * coverage bars compare against file counts, so they need this.
   * (A '#' inside a file path would miscount by one — acceptable.)
   */
  countDocsByKind(kind: RowKind): number {
    const row = this.db
      .prepare<{ n: number }, [string]>(
        `SELECT COUNT(DISTINCT CASE WHEN instr(ref, '#') > 0
                  THEN substr(ref, 1, instr(ref, '#') - 1) ELSE ref END) AS n
         FROM rows WHERE kind = ?`,
      )
      .get(kind);
    return row?.n ?? 0;
  }

  /** Count of rows for a specific embedding model. */
  countForModel(model: string): number {
    const row = this.db
      .prepare<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM rows WHERE model = ?`)
      .get(model);
    return row?.n ?? 0;
  }

  /**
   * Idempotency guard for embedding-model changes. Compares the stored
   * model fingerprint (model name + dim) against the configured one.
   * On mismatch, resets the indexer watermarks to 0 so the next ticks
   * re-embed everything with the new model, and DELETES rows from other
   * models. The delete matters when the old and new model share a dim
   * (MiniLM → bge-small are both 384): dim filtering can't hide the
   * stale vectors, and mixing embedding spaces silently poisons every
   * search score. Content is never lost — every row re-embeds from its
   * source (chat.db, persona files, sandbox artifacts) as the walk
   * catches up.
   *
   * Returns true if a reset happened. Idempotent: subsequent calls
   * with the same (model, dim) are no-ops.
   */
  resetIfModelChanged(model: string, dim: number): boolean {
    const storedModel = this.getString("embed.model");
    const storedDim = this.getWatermark("embed.dim");
    if (storedModel === model && storedDim === dim) return false;
    this.setWatermark("msg.rowid", 0);
    this.setWatermark("person.mtime", 0);
    // Artifacts too — omitting this orphaned every artifact row at the
    // old dim on a model change (silently filtered out of all searches,
    // never re-embedded).
    this.setWatermark("artifact.mtime", 0);
    this.db.prepare(`DELETE FROM rows WHERE model != ?`).run(model);
    this.db.exec(`DELETE FROM rows_fts_refs`);
    this.db.exec(`DELETE FROM rows_fts`);
    this.db.exec(`INSERT INTO rows_fts (ref, text) SELECT ref, text FROM rows`);
    this.db.exec(`
      INSERT INTO rows_fts_refs (ref, fts_rowid)
      SELECT ref, rowid FROM rows_fts
    `);
    this.invalidateCache();
    this.setString("embed.model", model);
    this.setWatermark("embed.dim", dim);
    return true;
  }

  /** The embedding model recorded by resetIfModelChanged. Used by the
   *  indexer's skip-if-current guard so rows from an older model never
   *  read as "already indexed". */
  currentModel(): string | null {
    return this.getString("embed.model");
  }

  private getString(key: string): string | null {
    const row = this.db
      .prepare<{ value: string }, [string]>(`SELECT value FROM watermark_strings WHERE key = ?`)
      .get(key);
    return row?.value ?? null;
  }

  private setString(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO watermark_strings (key, value, updated) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated`,
      )
      .run(key, value, Date.now());
  }
}

type DbRow = {
  ref: string;
  kind: string;
  chat_guid: string | null;
  sender: string | null;
  ts: number;
  text: string;
  vec: Buffer;
  model: string;
  dim: number;
};

function rowToIndexRow(r: DbRow): IndexRow {
  return {
    ref: r.ref,
    kind: r.kind as RowKind,
    chatGuid: r.chat_guid,
    sender: r.sender,
    ts: r.ts,
    text: r.text,
    vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dim),
    model: r.model,
  };
}

/**
 * MMR + hard-dedup reranking. Given a relevance-sorted candidate pool,
 * pick `limit` hits that balance two goals:
 *
 *   - Relevance to the query (cosine score, already in `rankScore`).
 *   - Novelty vs. already-picked hits (1 − max cosine to picked).
 *
 * Combined score: `lambda * rankScore - (1 - lambda) * max_sim_to_picked`.
 * Lambda=1 → pure relevance (no diversity); lambda=0 → pure novelty.
 *
 * If `dedupThreshold` is set, any candidate whose pairwise cosine to an
 * already-picked hit exceeds the threshold is dropped entirely. This is
 * the "kill near-duplicates" knob — useful even with lambda close to 1.
 *
 * Both knobs are optional. The caller passes neither for the legacy
 * pure-cosine ranking. Pure function except for the cache lookup
 * (vectors live in the cache; candidates carry only the ref).
 */
function rerankForDiversity(
  candidates: SearchHit[],
  cache: Map<string, CacheRow>,
  _qvec: Float32Array,
  limit: number,
  lambda: number | undefined,
  dedupThreshold: number | undefined,
): SearchHit[] {
  if (candidates.length <= 1) return candidates.slice(0, limit);
  const lam = lambda === undefined ? 1 : Math.max(0, Math.min(1, lambda));
  const dedupAt = dedupThreshold ?? 1.01; // > 1 = never trips (cosine ≤ 1)

  // Pull vectors for all candidates once.
  const candVecs: Float32Array[] = candidates.map(
    (c) => cache.get(c.ref)?.vec ?? new Float32Array(0),
  );

  const picked: SearchHit[] = [];
  const pickedVecs: Float32Array[] = [];
  const remaining = candidates.map((_, i) => i); // indices into candidates

  while (picked.length < limit && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestRemainingPos = -1;

    for (let rp = 0; rp < remaining.length; rp++) {
      const i = remaining[rp]!;
      const cand = candidates[i]!;
      const candVec = candVecs[i]!;
      if (candVec.length === 0) continue;

      // Pairwise cosine to the most similar already-picked.
      let maxSim = 0;
      for (const pv of pickedVecs) {
        let dot = 0;
        for (let k = 0; k < candVec.length; k++) dot += candVec[k]! * pv[k]!;
        if (dot > maxSim) maxSim = dot;
      }
      // Hard dedup: drop near-duplicates outright.
      if (maxSim >= dedupAt) {
        remaining.splice(rp, 1);
        rp--;
        continue;
      }

      const mmrScore = lam * cand.rankScore - (1 - lam) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
        bestRemainingPos = rp;
      }
    }
    if (bestIdx === -1) break;
    picked.push(candidates[bestIdx]!);
    pickedVecs.push(candVecs[bestIdx]!);
    remaining.splice(bestRemainingPos, 1);
  }
  return picked;
}

/** Shared row filtering for dense + sparse legs (scope, kinds, sender, time). */
function passesFilters(r: CacheRow, opts: SearchOptions, rowKindSet: Set<RowKind> | null): boolean {
  switch (opts.scope.kind) {
    case "this-chat":
      if (r.chatGuid !== opts.scope.chatGuid) return false;
      break;
    case "person":
      if (r.sender !== opts.scope.sender) return false;
      break;
    case "kind":
      if (r.kind !== opts.scope.rowKind) return false;
      break;
    // "global": no scope filter
  }
  if (rowKindSet && !rowKindSet.has(r.kind)) return false;
  if (opts.senderFilter && r.sender !== opts.senderFilter) return false;
  if (typeof opts.sinceMs === "number" && r.ts < opts.sinceMs) return false;
  if (typeof opts.untilMs === "number" && r.ts >= opts.untilMs) return false;
  return true;
}

/** Reciprocal Rank Fusion constant (Cormack et al. 2009 default). */
const RRF_K = 60;

/**
 * Fuse the dense ranking with the sparse (BM25) ref list via RRF.
 *
 * Each leg contributes 1/(RRF_K + rank) per ref; refs on both legs sum.
 * Sparse refs are admitted even when their cosine fell below minScore
 * (that's the point — BM25 rescues exact-term hits dense can't see),
 * but only if they passed the scope/kind/time filters (i.e. they exist
 * in `scored`). rankScore on the fused hits becomes the RRF score;
 * the raw cosine stays in `score` for floors/labels downstream.
 */
function fuseWithSparse(
  dense: SearchHit[],
  scored: Map<string, SearchHit>,
  sparseRefsRanked: string[],
  limit: number,
): SearchHit[] {
  const legDepth = Math.max(limit * 5, 50);
  const rrf = new Map<string, number>();
  const denseTop = dense.slice(0, legDepth);
  for (let i = 0; i < denseTop.length; i++) {
    rrf.set(denseTop[i]!.ref, 1 / (RRF_K + i + 1));
  }
  let sparseRank = 0;
  for (const ref of sparseRefsRanked) {
    const hit = scored.get(ref);
    if (!hit) continue; // failed filters, or not in this dim/model
    sparseRank++;
    if (sparseRank > legDepth) break;
    rrf.set(ref, (rrf.get(ref) ?? 0) + 1 / (RRF_K + sparseRank));
  }
  const fused: SearchHit[] = [];
  for (const [ref, score] of rrf) {
    const hit = scored.get(ref);
    if (!hit) continue;
    fused.push({ ...hit, rankScore: score });
  }
  fused.sort((a, b) => b.rankScore - a.rankScore);
  return fused;
}

/** Normalize a vector in-place to unit length. */
export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}
