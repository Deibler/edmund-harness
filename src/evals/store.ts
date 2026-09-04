import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";

/**
 * Eval scores live in spend.db — the metrics substrate Phase 3 built.
 * One run = one judged batch (a weekly transcript sample, or a probe-set
 * replay after a persona edit); per-subject scores keep the raw detail
 * for the dashboard, the run row keeps the averages regressions compare.
 */

export type EvalKind = "weekly" | "probes";

export type EvalScore = {
  /** What was judged: a chat guid, or a probe id like "probe:are-you-ai". */
  subject: string;
  /** 1-10 each. */
  format: number;
  length: number;
  persona: number;
  note: string;
};

export type EvalRun = {
  id: number;
  kind: EvalKind;
  startedAtMs: number;
  finishedAtMs: number;
  model: string;
  nScored: number;
  avgFormat: number;
  avgLength: number;
  avgPersona: number;
  note: string | null;
};

type RunRow = {
  id: number;
  kind: string;
  started_at_ms: number;
  finished_at_ms: number;
  model: string;
  n_scored: number;
  avg_format: number;
  avg_length: number;
  avg_persona: number;
  note: string | null;
};

export class EvalStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "spend.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS eval_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER NOT NULL,
        model TEXT NOT NULL,
        n_scored INTEGER NOT NULL,
        avg_format REAL NOT NULL,
        avg_length REAL NOT NULL,
        avg_persona REAL NOT NULL,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS eval_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        subject TEXT NOT NULL,
        format INTEGER NOT NULL,
        length INTEGER NOT NULL,
        persona INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS eval_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_eval_scores_run ON eval_scores(run_id);
    `);
  }

  recordRun(args: {
    kind: EvalKind;
    startedAtMs: number;
    model: string;
    scores: EvalScore[];
    note?: string;
  }): EvalRun {
    const n = args.scores.length;
    const avg = (pick: (s: EvalScore) => number) =>
      n === 0 ? 0 : args.scores.reduce((a, s) => a + pick(s), 0) / n;
    const run: Omit<EvalRun, "id"> = {
      kind: args.kind,
      startedAtMs: args.startedAtMs,
      finishedAtMs: Date.now(),
      model: args.model,
      nScored: n,
      avgFormat: avg((s) => s.format),
      avgLength: avg((s) => s.length),
      avgPersona: avg((s) => s.persona),
      note: args.note ?? null,
    };
    const res = this.db
      .query<
        { id: number },
        [string, number, number, string, number, number, number, number, string | null]
      >(
        `INSERT INTO eval_runs (kind, started_at_ms, finished_at_ms, model, n_scored,
           avg_format, avg_length, avg_persona, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        run.kind,
        run.startedAtMs,
        run.finishedAtMs,
        run.model,
        run.nScored,
        run.avgFormat,
        run.avgLength,
        run.avgPersona,
        run.note,
      );
    const id = res?.id ?? 0;
    const insert = this.db.query(
      "INSERT INTO eval_scores (run_id, subject, format, length, persona, note) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const s of args.scores) {
      insert.run(id, s.subject, s.format, s.length, s.persona, s.note.slice(0, 500));
    }
    return { id, ...run };
  }

  /** Most recent finished run of a kind (excluding `excludeId`). */
  lastRun(kind: EvalKind, excludeId?: number): EvalRun | null {
    const row = this.db
      .query<RunRow, [string, number]>(
        "SELECT * FROM eval_runs WHERE kind = ? AND id != ? ORDER BY finished_at_ms DESC LIMIT 1",
      )
      .get(kind, excludeId ?? -1);
    return row ? fromRow(row) : null;
  }

  recentRuns(limit = 20): EvalRun[] {
    const rows = this.db
      .query<RunRow, [number]>("SELECT * FROM eval_runs ORDER BY finished_at_ms DESC LIMIT ?")
      .all(limit);
    return rows.map(fromRow);
  }

  getMeta(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM eval_meta WHERE key = ?")
      .get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO eval_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

function fromRow(row: RunRow): EvalRun {
  return {
    id: row.id,
    kind: row.kind as EvalKind,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    model: row.model,
    nScored: row.n_scored,
    avgFormat: row.avg_format,
    avgLength: row.avg_length,
    avgPersona: row.avg_persona,
    note: row.note,
  };
}
