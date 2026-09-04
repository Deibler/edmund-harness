import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { genId } from "../util/ids.ts";

/**
 * Refresh scripts — model-authored DETERMINISTIC recurring actions.
 *
 * The model writes a small async JS body once (fetch + shape the result);
 * the daemon then executes it on schedule in a sandboxed subprocess and
 * applies the returned value directly (e.g. a mirror widget update) —
 * zero model tokens per refresh. The model is invoked only when the
 * script starts failing (repair escalation via one-shot cron).
 *
 * This replaces the pattern where a cron fired a full model turn every
 * hour just to curl an API and re-render the same template (the mirror
 * weather widget: ~43s of model time per refresh, forever).
 *
 * Mirrors the DataTriggerStore pattern: same authored-artifact ownership
 * (session-scoped), same failure bookkeeping for backoff + self-repair.
 */

export type RefreshApplyKind = "mirror_content";

type RefreshScriptStatus = "armed" | "canceled";

export type RefreshScript = {
  id: string;
  sessionKey: string;
  /** Stable human name; re-arming the same name replaces the script. */
  name: string;
  /** What this refresh maintains + why (context for repair turns). */
  brief: string;
  /** Async JS function body: `return {...}` the apply target consumes. */
  script: string;
  applyKind: RefreshApplyKind;
  intervalMs: number;
  status: RefreshScriptStatus;
  createdAt: number;
  lastRunMs: number;
  lastOkMs: number;
  lastError: string | null;
  consecutiveFailures: number;
  /** One-line summary of the last successful apply (dashboards/list tool). */
  lastSummary: string | null;
};

type Row = {
  id: string;
  session_key: string;
  name: string;
  brief: string;
  script: string;
  apply_kind: string;
  interval_ms: number;
  status: string;
  created_at: number;
  last_run_ms: number;
  last_ok_ms: number;
  last_error: string | null;
  consecutive_failures: number;
  last_summary: string | null;
};

export class RefreshScriptStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "refresh.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refresh_scripts (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        name TEXT NOT NULL,
        brief TEXT NOT NULL DEFAULT '',
        script TEXT NOT NULL,
        apply_kind TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'armed',
        created_at INTEGER NOT NULL,
        last_run_ms INTEGER NOT NULL DEFAULT 0,
        last_ok_ms INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_summary TEXT
      );
      CREATE INDEX IF NOT EXISTS refresh_status_idx ON refresh_scripts(status, session_key);
    `);
  }

  create(args: {
    sessionKey: string;
    name: string;
    brief: string;
    script: string;
    applyKind: RefreshApplyKind;
    intervalMs: number;
  }): RefreshScript {
    const s: RefreshScript = {
      id: genId("rfs"),
      sessionKey: args.sessionKey,
      name: args.name,
      brief: args.brief,
      script: args.script,
      applyKind: args.applyKind,
      intervalMs: args.intervalMs,
      status: "armed",
      createdAt: Date.now(),
      lastRunMs: 0,
      lastOkMs: 0,
      lastError: null,
      consecutiveFailures: 0,
      lastSummary: null,
    };
    this.db
      .query(
        `INSERT INTO refresh_scripts
           (id, session_key, name, brief, script, apply_kind, interval_ms, status, created_at,
            last_run_ms, last_ok_ms, last_error, consecutive_failures, last_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'armed', ?, 0, 0, NULL, 0, NULL)`,
      )
      .run(s.id, s.sessionKey, s.name, s.brief, s.script, s.applyKind, s.intervalMs, s.createdAt);
    return s;
  }

  get(id: string): RefreshScript | null {
    const row = this.db.query("SELECT * FROM refresh_scripts WHERE id = ?").get(id) as Row | null;
    return row ? fromRow(row) : null;
  }

  listArmed(): RefreshScript[] {
    const rows = this.db
      .query("SELECT * FROM refresh_scripts WHERE status = 'armed' ORDER BY created_at ASC")
      .all() as Row[];
    return rows.map(fromRow);
  }

  listBySession(sessionKey: string, limit = 30): RefreshScript[] {
    const rows = this.db
      .query("SELECT * FROM refresh_scripts WHERE session_key = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionKey, limit) as Row[];
    return rows.map(fromRow);
  }

  /** Armed script with this name in this session (for replace-on-re-arm). */
  findArmedByName(sessionKey: string, name: string): RefreshScript | null {
    const row = this.db
      .query(
        "SELECT * FROM refresh_scripts WHERE session_key = ? AND name = ? AND status = 'armed'",
      )
      .get(sessionKey, name) as Row | null;
    return row ? fromRow(row) : null;
  }

  countArmedBySession(sessionKey: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM refresh_scripts WHERE session_key = ? AND status = 'armed'")
      .get(sessionKey) as { n: number };
    return row.n;
  }

  markRun(
    id: string,
    nowMs: number,
    outcome: { ok: true; summary: string | null } | { ok: false; error: string },
  ): void {
    if (outcome.ok) {
      this.db
        .query(
          `UPDATE refresh_scripts SET last_run_ms = ?, last_ok_ms = ?, last_error = NULL,
             consecutive_failures = 0, last_summary = ? WHERE id = ?`,
        )
        .run(nowMs, nowMs, outcome.summary, id);
    } else {
      this.db
        .query(
          `UPDATE refresh_scripts SET last_run_ms = ?, last_error = ?,
             consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
        )
        .run(nowMs, outcome.error.slice(0, 400), id);
    }
  }

  cancel(id: string, sessionKey?: string): boolean {
    const res = sessionKey
      ? this.db
          .query(
            "UPDATE refresh_scripts SET status='canceled' WHERE id=? AND session_key=? AND status='armed'",
          )
          .run(id, sessionKey)
      : this.db
          .query("UPDATE refresh_scripts SET status='canceled' WHERE id=? AND status='armed'")
          .run(id);
    return Number(res.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

function fromRow(row: Row): RefreshScript {
  return {
    id: row.id,
    sessionKey: row.session_key,
    name: row.name,
    brief: row.brief,
    script: row.script,
    applyKind: row.apply_kind as RefreshApplyKind,
    intervalMs: row.interval_ms,
    status: row.status as RefreshScriptStatus,
    createdAt: row.created_at,
    lastRunMs: row.last_run_ms,
    lastOkMs: row.last_ok_ms,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    lastSummary: row.last_summary,
  };
}
