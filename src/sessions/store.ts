import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "../db/open.ts";
import type { SessionKey } from "./key.ts";

export type SessionRecord = {
  sessionKey: SessionKey;
  /** Provider thread UUID. The legacy field name is retained for DB/API compatibility. */
  claudeSessionId: string | null;
  /** CLI that owns claudeSessionId. Null rows with an id predate Codex and mean Claude. */
  sessionBackend: "claude" | "codex" | null;
  chatGuid: string;
  isGroup: number;
  lastInboundMs: number;
  lastOutboundMs: number;
  createdAt: number;
  /** When the stale-response recovery sweep last fired a wake-up for this session. Used to cap retries. */
  lastRecoveryAttemptMs: number;
  /** FailureClass string of the most recent runner error for this session, or null after a successful turn. */
  lastErrorClass: string | null;
  /** When `lastErrorClass` was recorded. */
  lastErrorAtMs: number;
  /** Consecutive heal-and-retry attempts since the last successful turn. */
  healAttemptsCount: number;
  /** When the fallback-notice sweep last sent a "still on it" note for this
   *  session. Compared against lastInboundMs so each unanswered burst gets
   *  at most one notice — a fresh inbound after the notice re-arms it. */
  lastFallbackMs: number;
  /** SHA fingerprint of the shared persona surface (IDENTITY/SOUL/VENUE_*
   *  + code version stamp) as of the last successful cold-spawn. When the
   *  current fingerprint diverges from this, runClaude force-cold-spawns
   *  so persona edits propagate to resumed sessions automatically. */
  systemPromptHash: string | null;
};

export class StateStore {
  private db: Database;
  // Cursor write batching: the chat.db watcher calls setCursor for every
  // observed row including dropped ones (gate-fail, echo, scaffolding). On a
  // chatty group that's many writes per second — each its own UPSERT + WAL
  // fsync. Keep cursor values in memory; flush dirty ones every 2s and on
  // close(). A crash loses at most ~2s of cursor progress, which is fine:
  // the cursor's whole purpose is to skip rows we've already processed, and
  // on restart we re-scan that small window (filtered out by shouldAccept).
  private cursorMem = new Map<string, number>();
  private cursorDirty = new Set<string>();
  private cursorFlushTimer: ReturnType<typeof setInterval>;
  // Prepared-statement cache mirroring ChatDb.stmtCache. The same SQL strings
  // are re-prepared for every getSession / markTurnStart / upsertSession /
  // recordError call — multiple times per turn. Caching them by SQL text
  // collapses parse+plan to a single Map lookup. Bun's bun:sqlite already
  // has an internal LRU but it sits behind .query() and still does work
  // per call; storing the Statement directly skips that path entirely.
  private stmtCache = new Map<string, ReturnType<Database["query"]>>();

  /** Memoized prepared-statement getter. SQL strings should be literals
   *  (not interpolated per call) so the cache actually hits — every
   *  current call site already uses fixed SQL with `?` placeholders. */
  private q(sql: string): ReturnType<Database["query"]> {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.query(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "state.db");
    mkdirSync(dirname(path), { recursive: true });
    this.db = openDb(path);
    this.migrate();
    this.cursorFlushTimer = setInterval(() => this.flushCursors(), 2_000);
    if (typeof this.cursorFlushTimer.unref === "function") this.cursorFlushTimer.unref();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursor (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        claude_session_id TEXT,
        session_backend TEXT,
        chat_guid TEXT NOT NULL,
        is_group INTEGER NOT NULL,
        last_inbound_ms INTEGER NOT NULL DEFAULT 0,
        last_outbound_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_recovery_attempt_ms INTEGER NOT NULL DEFAULT 0,
        last_error_class TEXT,
        last_error_at_ms INTEGER NOT NULL DEFAULT 0,
        heal_attempts_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS replayed_inbound (
        session_key TEXT NOT NULL,
        row_id INTEGER NOT NULL,
        replayed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_key, row_id)
      );
      CREATE INDEX IF NOT EXISTS idx_replayed_session ON replayed_inbound(session_key);
      CREATE INDEX IF NOT EXISTS idx_replayed_session_at ON replayed_inbound(session_key, replayed_at_ms DESC);
      -- Auto-compact: per-session compaction state. last_compact_at_ms
      -- is the boundary recall uses to mark "outside current model
      -- context" (older hits get boosted). Stamped by markCompacted()
      -- after a successful in-place /compact in the warm worker. The
      -- pending / summary_* columns are legacy from the deprecated
      -- summarizer path; left in the schema for SQLite simplicity but
      -- no longer read or written.
      CREATE TABLE IF NOT EXISTS compaction_state (
        session_key   TEXT PRIMARY KEY,
        pending       INTEGER NOT NULL DEFAULT 0,
        summary_text  TEXT,
        summary_at_ms INTEGER NOT NULL DEFAULT 0,
        last_compact_at_ms INTEGER NOT NULL DEFAULT 0,
        total_compacts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_last_inbound ON sessions(last_inbound_ms DESC);
      -- Partial index for the recovery sweeper's "unanswered" predicate.
      CREATE INDEX IF NOT EXISTS idx_sessions_unanswered ON sessions(last_inbound_ms)
        WHERE last_inbound_ms > last_outbound_ms;
      -- Pending outbox: at most ONE undelivered reply per session. Populated
      -- when sendDeliver / recovery turn's delivery fails after the in-band
      -- bridge auto-heal already retried. Drained at the top of every turn
      -- (handleBatchInner, sweeper) before any new model invocation so the
      -- model can't be re-invoked to regenerate a reply that's already been
      -- composed — which is what caused the duplicate-reply cascade observed
      -- 2026-05-15.
      CREATE TABLE IF NOT EXISTS pending_outbox (
        session_key      TEXT PRIMARY KEY,
        reply_text       TEXT NOT NULL,
        chat_guid        TEXT NOT NULL,
        is_group         INTEGER NOT NULL,
        service          TEXT NOT NULL,
        first_failed_ms  INTEGER NOT NULL,
        attempt_count    INTEGER NOT NULL DEFAULT 1
      );
      -- Per-inbound routing record: which SESSION a given chat.db row was
      -- routed to live. The edmund DM and the trading (Wolf) DM share one
      -- physical iMessage thread, so chat-scoped recovery/catch-up can't tell
      -- them apart from chatGuid alone. This records the live decision so a
      -- Wolf message is never later replayed into the edmund session (and
      -- vice-versa). Bounded by periodic prune (keep ~30 days).
      CREATE TABLE IF NOT EXISTS message_routing (
        row_id       INTEGER PRIMARY KEY,
        session_key  TEXT NOT NULL,
        at_ms        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routing_at ON message_routing(at_ms);
      -- Outbound attribution: which ORCHESTRATOR sent a given reply chunk.
      -- iMessage assigns the message GUID server-side, so we can't key by
      -- row; instead we record (chat, exact chunk text, send time) and the
      -- visibility filter matches is_from_me history rows by text + a time
      -- window. Only written when [[orchestrators]] are configured. Pruned
      -- alongside message_routing.
      CREATE TABLE IF NOT EXISTS sent_attribution (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_guid    TEXT NOT NULL,
        orchestrator TEXT NOT NULL,
        text         TEXT NOT NULL,
        at_ms        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sent_attr_chat ON sent_attribution(chat_guid, at_ms);
      -- Durable inbound ack: every accepted row gets a row here BEFORE the
      -- watcher cursor advances, and it's deleted only once a turn has
      -- actually answered it (handleBatch clears <= the max answered rowId).
      -- A row that survives a boot means the daemon died between "cursor
      -- committed" and "turn ran" (e.g. inside the debounce window) — boot
      -- replays it through the normal catch-up coalescer. entry_json is a
      -- PendingEntry (same shape as data/pending/*.jsonl lines).
      CREATE TABLE IF NOT EXISTS inbound_ack (
        row_id       INTEGER PRIMARY KEY,
        session_key  TEXT NOT NULL,
        entry_json   TEXT NOT NULL,
        created_ms   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_ack_session ON inbound_ack(session_key, row_id);
    `);
    // In-place column adds for DBs that predate these columns. Each ALTER
    // is wrapped so a re-run on an already-migrated DB is a no-op.
    for (const sql of [
      "ALTER TABLE sessions ADD COLUMN last_recovery_attempt_ms INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sessions ADD COLUMN last_error_class TEXT",
      "ALTER TABLE sessions ADD COLUMN last_error_at_ms INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sessions ADD COLUMN heal_attempts_count INTEGER NOT NULL DEFAULT 0",
      // People/group file maintainer: last time the background pass ran for
      // this session. Used to gate min-interval and to skip when no new
      // messages arrived since the last run.
      "ALTER TABLE sessions ADD COLUMN last_maintained_at_ms INTEGER NOT NULL DEFAULT 0",
      // Persona fingerprint: SHA of the shared persona surface (IDENTITY,
      // SOUL, VENUE_*, plus the code-baked output/memory/epistemic rules)
      // at the time this session was last cold-started. When the
      // fingerprint changes (operator tunes persona files), runClaude
      // detects the mismatch and forces a cold spawn so the resumed
      // session doesn't keep running the stale baked-in prompt.
      "ALTER TABLE sessions ADD COLUMN system_prompt_hash TEXT",
      // Fallback-notice sweep: last time a "still on it" stopgap note was
      // sent for this session's unanswered burst. See recovery/fallback.ts.
      "ALTER TABLE sessions ADD COLUMN last_fallback_ms INTEGER NOT NULL DEFAULT 0",
      // Provider owning claude_session_id. Existing non-null ids are treated
      // as Claude by the routing layer for backward compatibility.
      "ALTER TABLE sessions ADD COLUMN session_backend TEXT",
    ]) {
      try {
        this.db.exec(sql);
      } catch {
        // column already exists
      }
    }
  }

  /** Record which session an accepted inbound row was routed to (live path
   *  and catch-up). Idempotent on row_id. */
  recordRouting(rowId: number, sessionKey: SessionKey, atMs: number = Date.now()): void {
    this.q(
      `INSERT INTO message_routing (row_id, session_key, at_ms) VALUES (?, ?, ?)
       ON CONFLICT(row_id) DO UPDATE SET session_key = excluded.session_key, at_ms = excluded.at_ms`,
    ).run(rowId, sessionKey, atMs);
  }

  /** Durable ack for an accepted inbound row. Written before the watcher
   *  cursor advances; idempotent on row_id (watcher retry after a failed
   *  enqueue re-writes the same row). Throws on DB failure so the caller
   *  leaves the cursor in place and the watcher retries the row. */
  writeInboundAck(rowId: number, sessionKey: SessionKey, entryJson: string): void {
    this.q(
      `INSERT INTO inbound_ack (row_id, session_key, entry_json, created_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(row_id) DO UPDATE SET session_key = excluded.session_key, entry_json = excluded.entry_json`,
    ).run(rowId, sessionKey, entryJson, Date.now());
  }

  /** Clear acks a completed turn has answered: everything for the session up
   *  to and including maxRowId. Rows above it (follow-ups re-enqueued for
   *  their own turn) survive until that turn completes. */
  clearInboundAcks(sessionKey: SessionKey, maxRowId: number): void {
    this.q("DELETE FROM inbound_ack WHERE session_key = ? AND row_id <= ?").run(
      sessionKey,
      maxRowId,
    );
  }

  /** Drop a single ack (boot replay skipping an already-answered or expired
   *  orphan). Precise on purpose — must not touch other pending rows. */
  deleteInboundAck(rowId: number): void {
    this.q("DELETE FROM inbound_ack WHERE row_id = ?").run(rowId);
  }

  /** All outstanding acks, oldest first. Read at boot (orphan replay) and by
   *  the CLI audit surface. */
  listInboundAcks(): Array<{
    rowId: number;
    sessionKey: SessionKey;
    entryJson: string;
    createdMs: number;
  }> {
    const rows = this.q(
      "SELECT row_id, session_key, entry_json, created_ms FROM inbound_ack ORDER BY row_id ASC",
    ).all() as Array<{
      row_id: number;
      session_key: string;
      entry_json: string;
      created_ms: number;
    }>;
    return rows.map((r) => ({
      rowId: r.row_id,
      sessionKey: r.session_key as SessionKey,
      entryJson: r.entry_json,
      createdMs: r.created_ms,
    }));
  }

  /** The session a row was routed to, or null if we have no record. */
  getRoutedSession(rowId: number): SessionKey | null {
    const row = this.q("SELECT session_key FROM message_routing WHERE row_id = ?").get(rowId) as
      | { session_key: string }
      | undefined;
    return row?.session_key ?? null;
  }

  /** Drop routing records older than `beforeMs` (housekeeping). */
  pruneRouting(beforeMs: number): void {
    this.q("DELETE FROM message_routing WHERE at_ms < ?").run(beforeMs);
    this.q("DELETE FROM sent_attribution WHERE at_ms < ?").run(beforeMs);
  }

  /** Record which orchestrator sent each delivered reply chunk. */
  recordSentAttribution(
    chatGuid: string,
    orchestrator: string,
    chunks: string[],
    atMs: number = Date.now(),
  ): void {
    const stmt = this.q(
      "INSERT INTO sent_attribution (chat_guid, orchestrator, text, at_ms) VALUES (?, ?, ?, ?)",
    );
    for (const text of chunks) {
      if (text.trim().length === 0) continue;
      stmt.run(chatGuid, orchestrator, text, atMs);
    }
  }

  /** Outbound attributions for one chat since `sinceMs` (visibility filter). */
  attributionsFor(
    chatGuid: string,
    sinceMs: number,
  ): { orchestrator: string; text: string; atMs: number }[] {
    const rows = this.q(
      `SELECT orchestrator, text, at_ms FROM sent_attribution
       WHERE chat_guid = ? AND at_ms >= ? ORDER BY at_ms DESC LIMIT 2000`,
    ).all(chatGuid, sinceMs) as { orchestrator: string; text: string; at_ms: number }[];
    return rows.map((r) => ({ orchestrator: r.orchestrator, text: r.text, atMs: r.at_ms }));
  }

  getCursor(name: string, fallback: number): number {
    const mem = this.cursorMem.get(name);
    if (mem !== undefined) return mem;
    const row = this.q("SELECT value FROM cursor WHERE name = ?").get(name) as
      | { value: number }
      | undefined;
    const v = row?.value ?? fallback;
    this.cursorMem.set(name, v);
    return v;
  }

  setCursor(name: string, value: number): void {
    const prev = this.cursorMem.get(name);
    if (prev === value) return;
    this.cursorMem.set(name, value);
    this.cursorDirty.add(name);
  }

  /** Flush dirty in-memory cursor values to SQLite. Called by the 2s timer
   *  and on close(). Public so the daemon's SIGTERM handler can call it
   *  before exit if desired. */
  flushCursors(): void {
    if (this.cursorDirty.size === 0) return;
    const stmt = this.q(
      "INSERT INTO cursor(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
    );
    for (const name of this.cursorDirty) {
      const v = this.cursorMem.get(name);
      if (v !== undefined) stmt.run(name, v);
    }
    this.cursorDirty.clear();
  }

  getSession(sessionKey: SessionKey): SessionRecord | null {
    const row = this.q(`${SESSION_SELECT_COLS} WHERE session_key = ?`).get(sessionKey) as
      | SessionRecord
      | undefined;
    return row ?? null;
  }

  /** Stamp that a fallback "still on it" notice went out for the current
   *  unanswered burst. Does NOT touch last_outbound_ms — the session still
   *  owes its real reply, so the recovery sweeper must keep seeing it. */
  markFallbackSent(sessionKey: SessionKey, sentAtMs: number): void {
    this.q("UPDATE sessions SET last_fallback_ms = ? WHERE session_key = ?").run(
      sentAtMs,
      sessionKey,
    );
  }

  markRecoveryAttempted(sessionKey: SessionKey, attemptedAtMs: number): void {
    this.q("UPDATE sessions SET last_recovery_attempt_ms = ? WHERE session_key = ?").run(
      attemptedAtMs,
      sessionKey,
    );
  }

  /** Read the SHA fingerprint of the shared persona surface as of the last
   *  successful cold spawn for this session. Returns null when the session
   *  is new or pre-dates the fingerprint feature. */
  getSystemPromptHash(sessionKey: SessionKey): string | null {
    const row = this.q("SELECT system_prompt_hash AS h FROM sessions WHERE session_key = ?").get(
      sessionKey,
    ) as { h?: string | null } | undefined;
    return row?.h ?? null;
  }

  /** Stamp the persona fingerprint after a successful cold spawn. Used to
   *  detect persona edits in subsequent turns and force a fresh spawn. */
  setSystemPromptHash(sessionKey: SessionKey, hash: string): void {
    this.q("UPDATE sessions SET system_prompt_hash = ? WHERE session_key = ?").run(
      hash,
      sessionKey,
    );
  }

  /** Read the wall-clock ms of the most recent persona-maintainer pass for
   *  this session. Returns 0 if the session has never been maintained (or
   *  if no row exists yet). */
  getLastMaintainedAtMs(sessionKey: SessionKey): number {
    const row = this.q(
      "SELECT last_maintained_at_ms AS ms FROM sessions WHERE session_key = ?",
    ).get(sessionKey) as { ms?: number } | undefined;
    return row?.ms ?? 0;
  }

  /** Stamp the maintainer run timestamp. Used by the maintainer's min-interval
   *  gate and its "skip if no new messages" check. */
  setLastMaintainedAtMs(sessionKey: SessionKey, ms: number): void {
    this.q("UPDATE sessions SET last_maintained_at_ms = ? WHERE session_key = ?").run(
      ms,
      sessionKey,
    );
  }

  /**
   * Record the classified failure for a session's most recent runner
   * error. Increments `heal_attempts_count` so the sweeper / runner can
   * decide when to back off. Cleared by `clearError` on a successful turn.
   */
  recordError(sessionKey: SessionKey, errorClass: string, atMs: number): void {
    this.q(
      `UPDATE sessions
         SET last_error_class = ?, last_error_at_ms = ?, heal_attempts_count = heal_attempts_count + 1
         WHERE session_key = ?`,
    ).run(errorClass, atMs, sessionKey);
  }

  clearError(sessionKey: SessionKey): void {
    this.q(
      "UPDATE sessions SET last_error_class = NULL, last_error_at_ms = 0, heal_attempts_count = 0 WHERE session_key = ?",
    ).run(sessionKey);
  }

  /**
   * Mark a chat.db rowId as already replayed for this session. Used by
   * `runRecoveryTurn` to avoid double-firing the same recovery turn if
   * the model chose silence (or the reply itself errored). Bounded
   * per-session: callers should periodically prune via `pruneReplayed`.
   */
  markReplayed(sessionKey: SessionKey, rowId: number, atMs: number): void {
    this.q(
      `INSERT INTO replayed_inbound(session_key, row_id, replayed_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(session_key, row_id) DO UPDATE SET replayed_at_ms = excluded.replayed_at_ms`,
    ).run(sessionKey, rowId, atMs);
  }

  wasReplayed(sessionKey: SessionKey, rowId: number): boolean {
    const row = this.q(
      "SELECT 1 FROM replayed_inbound WHERE session_key = ? AND row_id = ? LIMIT 1",
    ).get(sessionKey, rowId);
    return row !== undefined && row !== null;
  }

  /**
   * Keep the most-recent `keep` replayed-rowId entries per session. Older
   * entries are deleted. Called periodically by the sweeper; cheap.
   */
  pruneReplayed(sessionKey: SessionKey, keep: number): void {
    this.q(
      `DELETE FROM replayed_inbound
         WHERE session_key = ?
           AND row_id NOT IN (
             SELECT row_id FROM replayed_inbound
             WHERE session_key = ?
             ORDER BY replayed_at_ms DESC
             LIMIT ?
           )`,
    ).run(sessionKey, sessionKey, keep);
  }

  upsertSession(
    rec: Omit<
      SessionRecord,
      | "createdAt"
      | "lastRecoveryAttemptMs"
      | "lastErrorClass"
      | "lastErrorAtMs"
      | "healAttemptsCount"
      | "lastFallbackMs"
      | "systemPromptHash"
      | "sessionBackend"
    > & {
      createdAt?: number;
    },
  ): void {
    const createdAt = rec.createdAt ?? Date.now();
    this.q(
      `INSERT INTO sessions(session_key, claude_session_id, chat_guid, is_group, last_inbound_ms, last_outbound_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           claude_session_id = excluded.claude_session_id,
           last_inbound_ms = excluded.last_inbound_ms,
           last_outbound_ms = excluded.last_outbound_ms`,
    ).run(
      rec.sessionKey,
      rec.claudeSessionId,
      rec.chatGuid,
      rec.isGroup,
      rec.lastInboundMs,
      rec.lastOutboundMs,
      createdAt,
    );
  }

  setClaudeSessionId(sessionKey: SessionKey, claudeSessionId: string | null): void {
    this.q("UPDATE sessions SET claude_session_id = ? WHERE session_key = ?").run(
      claudeSessionId,
      sessionKey,
    );
  }

  /** Atomically persist the provider and its opaque thread id. */
  setModelSession(
    sessionKey: SessionKey,
    claudeSessionId: string | null,
    backend: "claude" | "codex",
  ): void {
    this.q(
      "UPDATE sessions SET claude_session_id = ?, session_backend = ? WHERE session_key = ?",
    ).run(claudeSessionId, backend, sessionKey);
  }

  setSessionBackend(sessionKey: SessionKey, backend: "claude" | "codex"): void {
    this.q("UPDATE sessions SET session_backend = ? WHERE session_key = ?").run(
      backend,
      sessionKey,
    );
  }

  /**
   * Read the most recent successful-compaction timestamp for this
   * session. Returns 0 if the session has never been compacted.
   * Used by recall to mark the boundary between "in current model
   * context" (post-compact) and "outside context" (pre-compact) so
   * recall can boost the latter.
   */
  getLastCompactAtMs(sessionKey: SessionKey): number {
    const row = this.q("SELECT last_compact_at_ms FROM compaction_state WHERE session_key = ?").get(
      sessionKey,
    ) as { last_compact_at_ms: number } | undefined;
    return row?.last_compact_at_ms ?? 0;
  }

  /**
   * Stamp a successful `/compact` on this session: bump the
   * last_compact_at_ms boundary recall reads, and tick total_compacts.
   * Called from turn.ts after WorkerPool.compactIfWarm returns ok.
   * Idempotent.
   */
  markCompacted(sessionKey: SessionKey): void {
    this.q(
      `INSERT INTO compaction_state(session_key, last_compact_at_ms, total_compacts)
         VALUES (?, ?, 1)
         ON CONFLICT(session_key) DO UPDATE SET
           last_compact_at_ms = excluded.last_compact_at_ms,
           total_compacts = compaction_state.total_compacts + 1`,
    ).run(sessionKey, Date.now());
  }

  /**
   * Narrow pre-turn update: set last_inbound_ms (and optionally claude session
   * id) on an existing row. Used in place of a full upsertSession when we
   * just want the recovery sweeper to see "we're working on this turn" — the
   * full upsert (with chatGuid/isGroup) is reserved for end-of-turn writes
   * where those columns may have changed. Falls back to a full upsert if the
   * row doesn't exist yet (first-ever inbound for this session).
   */
  markTurnStart(rec: {
    sessionKey: SessionKey;
    claudeSessionId: string | null;
    chatGuid: string;
    isGroup: number;
    lastInboundMs: number;
  }): void {
    const res = this.q(
      "UPDATE sessions SET claude_session_id = ?, last_inbound_ms = ? WHERE session_key = ?",
    ).run(rec.claudeSessionId, rec.lastInboundMs, rec.sessionKey);
    if (Number(res.changes) === 0) {
      this.upsertSession({ ...rec, lastOutboundMs: 0 });
    }
  }

  /**
   * Narrow mid-turn update: a tool-driven send (send_message / send_attachment
   * in the MCP subprocess) just delivered to this session's chat, so record
   * the outbound NOW rather than waiting for end-of-turn bookkeeping. Without
   * this, a turn that dies after the tool send (runner timeout, daemon
   * restart) leaves last_outbound_ms stale and the recovery sweeper re-fires
   * on a burst the user already saw answered.
   *
   * MAX() keeps the column monotonic under concurrent writers (the daemon's
   * end-of-turn upsert and this MCP-process write race on the same row).
   * Updates only an existing row — markTurnStart has always created it by the
   * time any tool can fire; if not, this is a no-op (returns false) rather
   * than inventing a row with a zero last_inbound_ms.
   */
  noteToolSend(sessionKey: SessionKey, atMs: number = Date.now()): boolean {
    const res = this.q(
      "UPDATE sessions SET last_outbound_ms = MAX(last_outbound_ms, ?) WHERE session_key = ?",
    ).run(atMs, sessionKey);
    return Number(res.changes) > 0;
  }

  listSessions(): SessionRecord[] {
    const rows = this.q(`${SESSION_SELECT_COLS} ORDER BY last_inbound_ms DESC`).all();
    return rows as SessionRecord[];
  }

  /**
   * Sessions that look "stuck": the last inbound is newer than the last
   * outbound (we owe a reply) and that inbound landed before `before`.
   * This is the recovery sweeper's candidate set — querying it directly
   * (instead of scanning every session every sweep) keeps the sweep O(stuck)
   * not O(all sessions). Backed by `idx_sessions_unanswered`.
   */
  listSessionsNeedingRecovery(before: number): SessionRecord[] {
    const rows = this.q(
      `${SESSION_SELECT_COLS}
         WHERE last_inbound_ms > last_outbound_ms AND last_inbound_ms < ?
         ORDER BY last_inbound_ms DESC`,
    ).all(before);
    return rows as SessionRecord[];
  }

  /**
   * Hard delete a session row + every replayed-inbound entry for it.
   * Note: this does NOT touch the Claude Code session JSONL on disk —
   * callers (e.g. `edmund sessions wipe`) handle that separately.
   */
  deleteSession(sessionKey: SessionKey): void {
    this.q("DELETE FROM replayed_inbound WHERE session_key = ?").run(sessionKey);
    this.q("DELETE FROM pending_outbox WHERE session_key = ?").run(sessionKey);
    this.q("DELETE FROM sessions WHERE session_key = ?").run(sessionKey);
  }

  /**
   * Stash a reply that we generated but failed to deliver. At most one
   * entry per session — a newer failed reply *replaces* the older one
   * (the newer reply was the model's most-current take on the same
   * still-unanswered backlog). The drain sites (handleBatchInner,
   * sweeper) try to send this before re-invoking the model, which
   * prevents the duplicate-reply cascade where the bridge wedge made
   * each successive send appear to fail and triggered a fresh model
   * invocation per inbound.
   */
  putOutbox(rec: {
    sessionKey: SessionKey;
    replyText: string;
    chatGuid: string;
    isGroup: number;
    service: string;
    nowMs: number;
  }): void {
    this.q(
      `INSERT INTO pending_outbox(session_key, reply_text, chat_guid, is_group, service, first_failed_ms, attempt_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(session_key) DO UPDATE SET
           reply_text     = excluded.reply_text,
           chat_guid      = excluded.chat_guid,
           is_group       = excluded.is_group,
           service        = excluded.service,
           attempt_count  = pending_outbox.attempt_count + 1`,
    ).run(rec.sessionKey, rec.replyText, rec.chatGuid, rec.isGroup, rec.service, rec.nowMs);
  }

  /**
   * Records that one more delivery attempt was made and failed.
   *
   * `attempt_count` used to move only in putOutbox, which the drainer never
   * calls — a queued reply was re-INSERTed only if a *new* turn failed to send
   * it. So a reply the drainer retried a hundred times still read
   * `attempts=1`, and every backoff computed from it came out the same size
   * and never grew. One chat was refused 67 times in eleven minutes at a flat
   * interval because of this, each refusal an unpinned send against the very
   * registry entry that unpinned sends corrupt.
   */
  bumpOutboxAttempt(sessionKey: SessionKey): void {
    this.q(
      `UPDATE pending_outbox SET attempt_count = attempt_count + 1 WHERE session_key = ?`,
    ).run(sessionKey);
  }

  /** Repoints a queued reply at a chat row, once one has been resolved for it. */
  setOutboxChatGuid(sessionKey: SessionKey, chatGuid: string): void {
    this.q(`UPDATE pending_outbox SET chat_guid = ? WHERE session_key = ?`).run(
      chatGuid,
      sessionKey,
    );
  }

  getOutbox(sessionKey: SessionKey): {
    replyText: string;
    chatGuid: string;
    isGroup: number;
    service: string;
    firstFailedMs: number;
    attemptCount: number;
  } | null {
    const row = this.q(
      `SELECT reply_text     AS replyText,
                chat_guid      AS chatGuid,
                is_group       AS isGroup,
                service        AS service,
                first_failed_ms AS firstFailedMs,
                attempt_count   AS attemptCount
           FROM pending_outbox WHERE session_key = ?`,
    ).get(sessionKey) as
      | {
          replyText: string;
          chatGuid: string;
          isGroup: number;
          service: string;
          firstFailedMs: number;
          attemptCount: number;
        }
      | undefined;
    return row ?? null;
  }

  clearOutbox(sessionKey: SessionKey): void {
    this.q("DELETE FROM pending_outbox WHERE session_key = ?").run(sessionKey);
  }

  /**
   * Every queued reply, oldest first — the drainer's work list.
   *
   * A queued reply used to leave only when a turn ran for its session, so it
   * waited on the user writing again (or the 60s recovery sweep) and then
   * arrived on top of whatever they had just asked. Delivery is not a
   * conversational event and should not need one; this lets a retry loop see
   * the whole queue without a session key in hand.
   */
  listOutbox(): Array<{
    sessionKey: SessionKey;
    replyText: string;
    chatGuid: string;
    isGroup: number;
    service: string;
    firstFailedMs: number;
    attemptCount: number;
  }> {
    return this.q(
      `SELECT session_key      AS sessionKey,
              reply_text       AS replyText,
              chat_guid        AS chatGuid,
              is_group         AS isGroup,
              service          AS service,
              first_failed_ms  AS firstFailedMs,
              attempt_count    AS attemptCount
         FROM pending_outbox
        ORDER BY first_failed_ms ASC`,
    ).all() as Array<{
      sessionKey: SessionKey;
      replyText: string;
      chatGuid: string;
      isGroup: number;
      service: string;
      firstFailedMs: number;
      attemptCount: number;
    }>;
  }

  /**
   * The queued reply addressed to a chat, looked up by the chat GUID a send
   * was addressed with rather than by session. The deferred undelivered
   * alert only knows what the send path knew — the intended chat — and
   * answers "is that message still stuck?" from here.
   */
  getOutboxByChatGuid(chatGuid: string): {
    sessionKey: SessionKey;
    replyText: string;
    firstFailedMs: number;
    attemptCount: number;
  } | null {
    const row = this.q(
      `SELECT session_key      AS sessionKey,
              reply_text       AS replyText,
              first_failed_ms  AS firstFailedMs,
              attempt_count    AS attemptCount
         FROM pending_outbox WHERE chat_guid = ?`,
    ).get(chatGuid) as
      | { sessionKey: SessionKey; replyText: string; firstFailedMs: number; attemptCount: number }
      | undefined;
    return row ?? null;
  }

  /**
   * Run `fn` inside a SQLite transaction. The callback must be
   * synchronous (bun:sqlite transactions don't span awaits). If `fn`
   * throws, the transaction rolls back; the throw re-propagates.
   *
   * Use for sequences of writes that should be atomic — e.g. the
   * end-of-recovery-turn cleanup (markReplayed loop + prune + clear
   * error + upsert session), which used to leave partial state on a
   * mid-loop crash and also paid one WAL fsync per row.
   */
  transact<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    clearInterval(this.cursorFlushTimer);
    this.flushCursors();
    this.stmtCache.clear();
    this.db.close();
  }
}

/**
 * Shared SELECT prefix for session rows. Keeps the column→camelCase
 * aliasing identical between `getSession` and `listSessions` so a future
 * column add only has to happen here.
 */
const SESSION_SELECT_COLS = `
  SELECT
    session_key              AS sessionKey,
    claude_session_id        AS claudeSessionId,
    session_backend          AS sessionBackend,
    chat_guid                AS chatGuid,
    is_group                 AS isGroup,
    last_inbound_ms          AS lastInboundMs,
    last_outbound_ms         AS lastOutboundMs,
    created_at               AS createdAt,
    last_recovery_attempt_ms AS lastRecoveryAttemptMs,
    last_error_class         AS lastErrorClass,
    last_error_at_ms         AS lastErrorAtMs,
    heal_attempts_count      AS healAttemptsCount,
    last_fallback_ms         AS lastFallbackMs,
    system_prompt_hash       AS systemPromptHash
  FROM sessions
`;
