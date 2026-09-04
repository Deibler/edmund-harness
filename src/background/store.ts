import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { genId } from "../util/ids.ts";

/**
 * SQLite store for lightweight background tool jobs.
 *
 * Unlike agents (which spawn a full `claude -p` subprocess), bg jobs just
 * run a single tool call in a detached Node process, save the result to
 * the session sandbox, and fire a cron wake-up event. No extra LLM cost.
 *
 * Used for slow single-operation tools (Cloudflare Browser Run, long
 * web fetches, etc.) where spawning a full agent is overkill.
 */

type BgJobStatus = "pending" | "running" | "done" | "failed";

export type BgJob = {
  id: string;
  sessionKey: string;
  sandboxPath: string;
  toolName: string;
  argsJson: string;
  status: BgJobStatus;
  pid: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  resultPath: string | null;
  resultSummary: string | null;
  errorText: string | null;
  /** Stamped after the wake-up cron has been successfully written.
   *  Reaper uses this to catch jobs that finished but never woke
   *  their session (runner crashed between finish() and crons.create()). */
  wakeFiredAt: number | null;
};

export class BgJobStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "bg_jobs.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bg_jobs (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        sandbox_path TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        result_path TEXT,
        result_summary TEXT,
        error_text TEXT
      );
      CREATE INDEX IF NOT EXISTS bg_jobs_session_status_idx
        ON bg_jobs(session_key, status);
    `);
    // Migration: wake_fired_at column. Older DBs may not have it; the
    // ALTER throws if it already exists, which we swallow.
    //
    // CRITICAL: backfill in the SAME try block. Every pre-existing
    // finished row has wake_fired_at IS NULL by definition (the column
    // didn't exist when they finished). Without backfilling, the
    // reaper's listFinishedMissingWake sees ALL historical finished
    // jobs as "needs recovery" and fires hundreds of bg-job-done crons
    // to every chat — a catastrophic regression we hit on 2026-05-18.
    // Treat any existing finished row as already-woken: it either had
    // its wake fired the normal way back then, or its session has long
    // since moved on and a recovery wake-up is just noise/spam.
    try {
      this.db.exec("ALTER TABLE bg_jobs ADD COLUMN wake_fired_at INTEGER");
      const res = this.db
        .query(
          `UPDATE bg_jobs SET wake_fired_at = COALESCE(finished_at, ?)
           WHERE status IN ('done','failed') AND wake_fired_at IS NULL`,
        )
        .run(Date.now());
      const backfilled = Number(res.changes);
      if (backfilled > 0) {
        console.warn(
          `[bg-jobs] migration: backfilled wake_fired_at on ${backfilled} pre-existing finished rows`,
        );
      }
    } catch {
      // Column already present — no backfill needed (this run isn't the
      // first to see the column).
    }
  }

  create(input: {
    id: string;
    sessionKey: string;
    sandboxPath: string;
    toolName: string;
    argsJson: string;
  }): BgJob {
    const now = Date.now();
    const job: BgJob = {
      ...input,
      status: "pending",
      pid: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      resultPath: null,
      resultSummary: null,
      errorText: null,
      wakeFiredAt: null,
    };
    this.db
      .query(
        `INSERT INTO bg_jobs(id, session_key, sandbox_path, tool_name, args_json, status,
         pid, created_at, started_at, finished_at, result_path, result_summary, error_text)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        job.id,
        job.sessionKey,
        job.sandboxPath,
        job.toolName,
        job.argsJson,
        job.status,
        null,
        job.createdAt,
        null,
        null,
        null,
        null,
        null,
      );
    return job;
  }

  get(id: string): BgJob | null {
    const row = this.db.query("SELECT * FROM bg_jobs WHERE id = ?").get(id) as RawRow | undefined;
    return row ? rowToJob(row) : null;
  }

  setRunning(id: string, pid: number): void {
    this.db
      .query("UPDATE bg_jobs SET status='running', pid=?, started_at=? WHERE id=?")
      .run(pid, Date.now(), id);
  }

  finish(
    id: string,
    status: "done" | "failed",
    resultPath: string | null,
    resultSummary: string | null,
    errorText: string | null,
  ): void {
    this.db
      .query(
        "UPDATE bg_jobs SET status=?, finished_at=?, result_path=?, result_summary=?, error_text=? WHERE id=?",
      )
      .run(status, Date.now(), resultPath, resultSummary, errorText, id);
  }

  /** Stamp that the wake-up cron has been written for this job. Called
   *  by the runner after a successful crons.create() and by the reaper
   *  after it fires a recovery wake-up. Idempotent. */
  markWakeFired(id: string): void {
    this.db
      .query("UPDATE bg_jobs SET wake_fired_at=? WHERE id=? AND wake_fired_at IS NULL")
      .run(Date.now(), id);
  }

  /**
   * Find jobs stuck in pending (runner never started) or running (runner
   * crashed mid-execution). Used by the daemon reaper to catch wake-ups
   * that would otherwise never fire.
   */
  listStuck(opts: { pendingStaleMs: number; runningStaleMs: number }): BgJob[] {
    const now = Date.now();
    const pendingCutoff = now - opts.pendingStaleMs;
    const runningCutoff = now - opts.runningStaleMs;
    const rows = this.db
      .query(
        `SELECT * FROM bg_jobs
         WHERE (status = 'pending' AND created_at < ?)
            OR (status = 'running' AND (started_at IS NULL OR started_at < ?))`,
      )
      .all(pendingCutoff, runningCutoff) as RawRow[];
    return rows.map(rowToJob);
  }

  /**
   * Find finished jobs whose wake-up cron was never recorded (runner
   * crashed between `finish()` and `crons.create()`/`markWakeFired()`).
   *
   * `minAgeMs` is the lower bound — jobs younger than that are skipped
   * to give the normal wake-up path time to settle.
   *
   * `maxAgeMs` is the upper bound — jobs older than that are skipped
   * (and force-marked wake-fired) because the user has long since
   * moved on; a "your image is ready" message hours later is just
   * noise and risks the 2026-05-18 spam cascade if a migration ever
   * misses a backfill again. Belt-and-suspenders with the migration
   * backfill in the constructor.
   *
   * This closes the at-most-once gap in async-tool delivery: without it,
   * a runner that crashes mid-finalize leaves the session waiting
   * for a wake-up that will never come. With the upper bound, it can
   * only catch RECENT crashes — exactly the case it's designed for.
   */
  listFinishedMissingWake(opts: { minAgeMs: number; maxAgeMs: number }): BgJob[] {
    const now = Date.now();
    const newerThan = now - opts.maxAgeMs;
    const olderThan = now - opts.minAgeMs;
    const rows = this.db
      .query(
        `SELECT * FROM bg_jobs
         WHERE status IN ('done','failed')
           AND wake_fired_at IS NULL
           AND finished_at IS NOT NULL
           AND finished_at < ?
           AND finished_at > ?`,
      )
      .all(olderThan, newerThan) as RawRow[];
    return rows.map(rowToJob);
  }

  /**
   * For any finished job older than `maxAgeMs` that's still missing
   * wake_fired_at, force-stamp it now. Called once at startup to suppress
   * future spurious recoveries on old rows that somehow slipped through
   * the migration backfill. Returns count stamped.
   */
  suppressOldMissedWakes(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const res = this.db
      .query(
        `UPDATE bg_jobs SET wake_fired_at = COALESCE(finished_at, ?)
         WHERE status IN ('done','failed')
           AND wake_fired_at IS NULL
           AND finished_at IS NOT NULL
           AND finished_at < ?`,
      )
      .run(Date.now(), cutoff);
    return Number(res.changes);
  }

  listForSession(sessionKey: string, limit = 20): BgJob[] {
    const rows = this.db
      .query("SELECT * FROM bg_jobs WHERE session_key = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionKey, limit) as RawRow[];
    return rows.map(rowToJob);
  }

  close(): void {
    this.db.close();
  }
}

type RawRow = {
  id: string;
  session_key: string;
  sandbox_path: string;
  tool_name: string;
  args_json: string;
  status: BgJobStatus;
  pid: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  result_path: string | null;
  result_summary: string | null;
  error_text: string | null;
  wake_fired_at: number | null;
};

function rowToJob(r: RawRow): BgJob {
  return {
    id: r.id,
    sessionKey: r.session_key,
    sandboxPath: r.sandbox_path,
    toolName: r.tool_name,
    argsJson: r.args_json,
    status: r.status,
    pid: r.pid,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    resultPath: r.result_path,
    resultSummary: r.result_summary,
    errorText: r.error_text,
    wakeFiredAt: r.wake_fired_at ?? null,
  };
}

export function randomJobId(): string {
  return genId("bg");
}
