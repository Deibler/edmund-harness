import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";

/**
 * Cost ledger — every model invocation in the harness lands one row here.
 *
 * Two tables:
 *   turns       — one row per invocation (ts, session, subsystem, model,
 *                 duration, context tokens, cost). The raw substrate for
 *                 routing analysis and the eval loop.
 *   spend_daily — (day, session_key, subsystem) rollup kept in the same
 *                 write so dashboard queries never scan the raw table.
 *
 * Writers span processes (daemon, agent-runner, MCP subprocesses); openDb's
 * busy_timeout + WAL make cross-process appends safe. Costs come from the
 * Claude CLI's own result events (`total_cost_usd`) — we record, never
 * estimate.
 *
 * `total_cost_usd` is the running total for the whole model session, and a
 * resumed process carries it forward. For a one-shot call on a fresh session
 * that is the call's cost. For a turn that resumes a conversation it is not:
 * until 2026-09-24 those totals were recorded as turn costs, and the ledger
 * summed them to 4-11x the real spend (one DM logged $99.03 for a turn that
 * cost $0.11). Such callers pass the total through `sessionTotalUsd` and the
 * ledger stores the rise since that session's last total (see turnCost).
 *
 * Subsystems: turn | cron | agent | ghost | ghost-prescreen | maintainer |
 * catch-up | research-planner (open set — new callers add their own tag).
 */

export type SpendRecord = {
  sessionKey: string;
  subsystem: string;
  model?: string | null;
  /** The call's own cost: one-shot callers on a fresh session. */
  costUsd?: number | null;
  /** Callers that resume a conversation pass the CLI's running total here
   *  instead of costUsd, with the model session it belongs to. */
  sessionTotalUsd?: number | null;
  modelSessionId?: string | null;
  /** The CLI process was started with --resume, so a session the ledger has
   *  never seen already had spend before this total began. */
  resumedProcess?: boolean;
  durMs?: number | null;
  contextTokens?: number | null;
  tools?: number | null;
};

export type DailyRow = {
  day: string;
  sessionKey: string;
  subsystem: string;
  turns: number;
  costUsd: number;
  durMs: number;
};

/** Local calendar day (daemon timezone) — the rollup key. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class SpendLedger {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "spend.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_key TEXT NOT NULL,
        subsystem TEXT NOT NULL,
        model TEXT,
        dur_ms INTEGER,
        ctx_tokens INTEGER,
        cost_usd REAL,
        tools INTEGER
      );
      CREATE INDEX IF NOT EXISTS turns_ts_idx ON turns(ts);
      CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_key, subsystem, ts);
      CREATE TABLE IF NOT EXISTS spend_daily (
        day TEXT NOT NULL,
        session_key TEXT NOT NULL,
        subsystem TEXT NOT NULL,
        turns INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        dur_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, session_key, subsystem)
      );
    `);
    const cols = new Set(
      (this.db.query("PRAGMA table_info(turns)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!cols.has("model_session_id"))
      this.db.exec("ALTER TABLE turns ADD COLUMN model_session_id TEXT");
    if (!cols.has("session_total_usd"))
      this.db.exec("ALTER TABLE turns ADD COLUMN session_total_usd REAL");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS turns_model_session_idx ON turns(model_session_id, id)",
    );
  }

  /**
   * What this call cost. A running total costs its rise since the same
   * session's last recorded total. Null when that can't be known: the total
   * went down (a process killed mid-session restores an older total), or a
   * resumed session has no earlier total here. A fresh session's first total
   * is its first turn's cost.
   */
  turnCost(r: SpendRecord): number | null {
    if (r.sessionTotalUsd === undefined || r.sessionTotalUsd === null) return r.costUsd ?? null;
    if (!r.modelSessionId) return null;
    const prev = this.db
      .query(
        `SELECT session_total_usd AS t FROM turns
          WHERE model_session_id = ? AND session_total_usd IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(r.modelSessionId) as { t: number } | null;
    if (prev) {
      const rise = r.sessionTotalUsd - prev.t;
      return rise >= 0 ? rise : null;
    }
    return r.resumedProcess ? null : r.sessionTotalUsd;
  }

  /** Record one call; returns the cost it was booked at (null = unknown). */
  record(r: SpendRecord, nowMs = Date.now()): number | null {
    const cost = this.turnCost(r);
    this.db
      .query(
        `INSERT INTO turns (ts, session_key, subsystem, model, dur_ms, ctx_tokens, cost_usd, tools,
                            model_session_id, session_total_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nowMs,
        r.sessionKey,
        r.subsystem,
        r.model ?? null,
        r.durMs ?? null,
        r.contextTokens ?? null,
        cost,
        r.tools ?? null,
        r.modelSessionId ?? null,
        r.sessionTotalUsd ?? null,
      );
    this.db
      .query(
        `INSERT INTO spend_daily (day, session_key, subsystem, turns, cost_usd, dur_ms)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(day, session_key, subsystem) DO UPDATE SET
           turns = turns + 1,
           cost_usd = cost_usd + excluded.cost_usd,
           dur_ms = dur_ms + excluded.dur_ms`,
      )
      .run(localDay(nowMs), r.sessionKey, r.subsystem, cost ?? 0, r.durMs ?? 0);
    return cost;
  }

  /** Lifetime cost across all sessions for one subsystem tag. The guest
   *  campaign spend cap reads this with subsystem `guest:<campaign key>`.
   *  Sums the rollup, not the raw table, so it stays cheap forever. */
  totalCostFor(subsystem: string): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM spend_daily WHERE subsystem = ?")
      .get(subsystem) as { c: number };
    return row.c;
  }

  /** Invocation count for one (day, session, subsystem) — the ghost's
   *  daily-cap counter reads this. */
  countDay(day: string, sessionKey: string, subsystem: string): number {
    const row = this.db
      .query("SELECT turns FROM spend_daily WHERE day = ? AND session_key = ? AND subsystem = ?")
      .get(day, sessionKey, subsystem) as { turns: number } | null;
    return row?.turns ?? 0;
  }

  /** Daily rollups for the last N days (newest day first). */
  daily(days: number, nowMs = Date.now()): DailyRow[] {
    const cutoff = localDay(nowMs - days * 24 * 3_600_000);
    const rows = this.db
      .query(
        `SELECT day, session_key, subsystem, turns, cost_usd, dur_ms
         FROM spend_daily WHERE day >= ? ORDER BY day DESC, cost_usd DESC`,
      )
      .all(cutoff) as Array<{
      day: string;
      session_key: string;
      subsystem: string;
      turns: number;
      cost_usd: number;
      dur_ms: number;
    }>;
    return rows.map((r) => ({
      day: r.day,
      sessionKey: r.session_key,
      subsystem: r.subsystem,
      turns: r.turns,
      costUsd: r.cost_usd,
      durMs: r.dur_ms,
    }));
  }

  /** Most recent raw invocations (for the dashboard drill-down). */
  recent(limit = 100): Array<{
    ts: number;
    sessionKey: string;
    subsystem: string;
    model: string | null;
    durMs: number | null;
    ctxTokens: number | null;
    costUsd: number | null;
    tools: number | null;
  }> {
    const rows = this.db
      .query(
        `SELECT ts, session_key, subsystem, model, dur_ms, ctx_tokens, cost_usd, tools
         FROM turns ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      ts: number;
      session_key: string;
      subsystem: string;
      model: string | null;
      dur_ms: number | null;
      ctx_tokens: number | null;
      cost_usd: number | null;
      tools: number | null;
    }>;
    return rows.map((r) => ({
      ts: r.ts,
      sessionKey: r.session_key,
      subsystem: r.subsystem,
      model: r.model,
      durMs: r.dur_ms,
      ctxTokens: r.ctx_tokens,
      costUsd: r.cost_usd,
      tools: r.tools,
    }));
  }

  close(): void {
    this.db.close();
  }
}

// ─── Singleton (per data dir) ─────────────────────────────────────────
// Callers all over the daemon (turn.ts, fire.ts, think.ts, …) record fire-
// and-forget; one shared handle avoids a connection per call site. Failures
// must never break the calling turn — recording is best-effort.

const ledgers = new Map<string, SpendLedger>();

export function getSpendLedger(dataDir: string): SpendLedger {
  let l = ledgers.get(dataDir);
  if (!l) {
    l = new SpendLedger(dataDir);
    ledgers.set(dataDir, l);
  }
  return l;
}

/** Best-effort record — spend accounting must never break the turn. */
export function recordSpend(dataDir: string, r: SpendRecord, nowMs = Date.now()): void {
  try {
    getSpendLedger(dataDir).record(r, nowMs);
  } catch (err) {
    console.warn(`[spend] record failed: ${(err as Error).message}`);
  }
}

/**
 * The spend fields for a run that resumes a conversation (a turn, a cron
 * fire, a proactive fire). Every such caller goes through here, so none can
 * book the session's running total as the turn's cost.
 */
export function resumedRunSpend(result: {
  ok: boolean;
  totalCostUsd?: number;
  claudeSessionId?: string;
  resumedProcess?: boolean;
}): Pick<SpendRecord, "sessionTotalUsd" | "modelSessionId" | "resumedProcess"> {
  if (!result.ok || typeof result.totalCostUsd !== "number") return { sessionTotalUsd: null };
  return {
    sessionTotalUsd: result.totalCostUsd,
    modelSessionId: result.claudeSessionId ?? null,
    resumedProcess: result.resumedProcess === true,
  };
}
