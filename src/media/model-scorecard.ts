/**
 * Global, cross-session scorecard for generative models (image / video /
 * audio). Every generation attempt records an outcome here, and user reactions
 * relayed by Edmund get recorded too. The point: future generations — in ANY
 * session — can consult `modelScorecard()` (exposed as the `model_scorecard`
 * MCP tool) to pick a model that actually delivers and that the user has liked,
 * instead of rediscovering bad models per-conversation.
 *
 * Outcomes:
 *   - "generated" — the model returned a usable file (recorded automatically).
 *   - "failed"    — the call errored / returned no media (recorded automatically).
 *   - "liked"     — the user reacted positively (recorded via `rate_model_output`).
 *   - "rejected"  — the user disliked / asked to redo (via `rate_model_output`).
 *
 * Stored in its own `model_stats.db` so it's independent of session state and
 * survives session resets. Best-effort: a recording failure never blocks a
 * generation (the table open + insert are wrapped and only warn).
 */

import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { openDb } from "../db/open.ts";
import { log } from "../util/log.ts";

export type MediaKind = "image" | "video" | "audio";
export type ModelOutcome = "generated" | "failed" | "liked" | "rejected";

const DB_FILE = "model_stats.db";

function open(dataDir: string): Database {
  const db = openDb(resolve(dataDir, DB_FILE));
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_outcomes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,
      model       TEXT NOT NULL,
      outcome     TEXT NOT NULL,
      detail      TEXT,
      session_key TEXT,
      ts          INTEGER NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_model_outcomes_lookup ON model_outcomes(kind, model)");
  return db;
}

/** Append one outcome. Best-effort — swallows + warns on any failure so a
 *  generation flow is never blocked by bookkeeping. */
export function recordModelOutcome(args: {
  dataDir: string;
  kind: MediaKind;
  model: string;
  outcome: ModelOutcome;
  detail?: string;
  sessionKey?: string;
}): void {
  try {
    const db = open(args.dataDir);
    try {
      db.query(
        `INSERT INTO model_outcomes (kind, model, outcome, detail, session_key, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        args.kind,
        args.model,
        args.outcome,
        args.detail ?? null,
        args.sessionKey ?? null,
        Date.now(),
      );
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn("model-scorecard", "record failed", {
      model: args.model,
      outcome: args.outcome,
      err: (err as Error).message,
    });
  }
}

export type ModelStat = {
  kind: MediaKind;
  model: string;
  generated: number;
  failed: number;
  liked: number;
  rejected: number;
  lastUsedMs: number;
  /** generated / (generated + failed); 1 when never tried. */
  successRate: number;
  /** liked / (liked + rejected); null when no sentiment recorded yet. */
  approval: number | null;
  /** Composite 0-1 ranking signal — see computeScore. Higher is better. */
  score: number;
};

/**
 * Quality signal that balances "does it work" against "does the user like it",
 * defaulting unrated approval to neutral so a brand-new reliable model isn't
 * unfairly buried under one with a single lucky like. A light sample-size
 * dampener keeps a 1-for-1 model from outranking a proven 40-for-42 one.
 */
function computeScore(s: {
  generated: number;
  failed: number;
  liked: number;
  rejected: number;
}): { successRate: number; approval: number | null; score: number } {
  const attempts = s.generated + s.failed;
  const successRate = attempts === 0 ? 1 : s.generated / attempts;
  const sentiment = s.liked + s.rejected;
  const approval = sentiment === 0 ? null : s.liked / sentiment;
  // Confidence grows with attempts; caps near 1 around ~10 samples.
  const confidence = attempts / (attempts + 3);
  const base = 0.5 * successRate + 0.5 * (approval ?? 0.5);
  // Pull unconfident models toward the neutral 0.5 so they're explored but
  // don't dominate the ranking on thin evidence.
  const score = 0.5 + (base - 0.5) * confidence;
  return { successRate, approval, score };
}

/** Aggregated per-model stats, best-first. Optionally filtered to one kind. */
export function modelScorecard(args: { dataDir: string; kind?: MediaKind }): ModelStat[] {
  let db: Database;
  try {
    db = open(args.dataDir);
  } catch (err) {
    log.warn("model-scorecard", "open failed", { err: (err as Error).message });
    return [];
  }
  try {
    const where = args.kind ? "WHERE kind = ?" : "";
    const rows = db
      .query(
        `SELECT kind, model,
                SUM(outcome = 'generated') AS generated,
                SUM(outcome = 'failed')    AS failed,
                SUM(outcome = 'liked')     AS liked,
                SUM(outcome = 'rejected')  AS rejected,
                MAX(ts)                    AS lastUsedMs
         FROM model_outcomes
         ${where}
         GROUP BY kind, model`,
      )
      .all(...(args.kind ? [args.kind] : [])) as Array<{
      kind: MediaKind;
      model: string;
      generated: number;
      failed: number;
      liked: number;
      rejected: number;
      lastUsedMs: number;
    }>;
    return rows
      .map((r) => ({ ...r, ...computeScore(r) }))
      .sort((a, b) => b.score - a.score || b.generated - a.generated);
  } finally {
    db.close();
  }
}
