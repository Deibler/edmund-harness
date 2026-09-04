import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { genId } from "../util/ids.ts";

/**
 * Data triggers — fully model-authored watch conditions. The model writes
 * BOTH the probe (any URL, or a JS expression evaluated live inside the
 * RadarOmega app whose contracts it has introspected) AND the predicate
 * that decides "fire". The daemon evaluates on a schedule for free; the
 * model is invoked only when a condition actually fires, with the
 * triggering data in hand.
 *
 * Nothing domain-specific lives here: a tornado-warning watch, a tropical
 * genesis watch, an HRRR-updraft-helicity threshold over a county, a "new
 * mesoscale discussion mentions Lancaster" watch — all are just different
 * probes + predicates the model composes itself.
 */

export type TriggerSource =
  | {
      kind: "url";
      url: string;
      headers?: Record<string, string>;
      /** POST turns the probe into a webhook-style call; body sent verbatim. */
      method?: "GET" | "POST";
      body?: string;
    }
  | { kind: "app_js"; expression: string }
  /** Internal-state probe over chat.db: "how long since I heard from X?"
   *  Data handed to the predicate: { lastInboundMs, lastOutboundMs,
   *  hoursSinceInbound, hoursSinceOutbound, nowMs } (null fields when the
   *  chat has no such message). Give handle for a DM, chatGuid for exact. */
  | { kind: "chat_silence"; handle?: string; chatGuid?: string };

export type TriggerStatus = "armed" | "done" | "canceled" | "expired";

export type DataTrigger = {
  id: string;
  sessionKey: string;
  name: string;
  /** Why this exists + what future-you promised to do when it fires. */
  brief: string;
  source: TriggerSource;
  /** JS function body (data, state) => boolean | {fire, summary}. */
  predicate: string;
  /** Predicate's persistent scratch state across checks. */
  state: Record<string, unknown>;
  status: TriggerStatus;
  oneShot: boolean;
  checkIntervalMs: number;
  cooldownMs: number;
  expiresMs: number | null;
  createdAt: number;
  lastCheckedMs: number;
  lastFiredMs: number;
  fireCount: number;
  /** Last evaluation error, surfaced in list_triggers for self-repair. */
  lastError: string | null;
  /** Failed checks since the last clean one — drives the watcher's backoff. */
  consecutiveFailures: number;
};

type Row = {
  id: string;
  session_key: string;
  name: string;
  brief: string;
  source_json: string;
  predicate: string;
  state_json: string;
  status: string;
  one_shot: number;
  check_interval_ms: number;
  cooldown_ms: number;
  expires_ms: number | null;
  created_at: number;
  last_checked_ms: number;
  last_fired_ms: number;
  fire_count: number;
  last_error: string | null;
  consecutive_failures: number;
};

export class DataTriggerStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "triggers.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        name TEXT NOT NULL,
        brief TEXT NOT NULL DEFAULT '',
        source_json TEXT NOT NULL,
        predicate TEXT NOT NULL,
        state_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'armed',
        one_shot INTEGER NOT NULL DEFAULT 0,
        check_interval_ms INTEGER NOT NULL,
        cooldown_ms INTEGER NOT NULL,
        expires_ms INTEGER,
        created_at INTEGER NOT NULL,
        last_checked_ms INTEGER NOT NULL DEFAULT 0,
        last_fired_ms INTEGER NOT NULL DEFAULT 0,
        fire_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS triggers_status_idx ON triggers(status, session_key);
    `);
    try {
      this.db.exec(
        "ALTER TABLE triggers ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0",
      );
    } catch {
      // Column already exists.
    }
  }

  create(args: {
    sessionKey: string;
    name: string;
    brief: string;
    source: TriggerSource;
    predicate: string;
    state?: Record<string, unknown>;
    oneShot: boolean;
    checkIntervalMs: number;
    cooldownMs: number;
    expiresMs: number | null;
  }): DataTrigger {
    const t: DataTrigger = {
      id: genId("trg"),
      sessionKey: args.sessionKey,
      name: args.name,
      brief: args.brief,
      source: args.source,
      predicate: args.predicate,
      state: args.state ?? {},
      status: "armed",
      oneShot: args.oneShot,
      checkIntervalMs: args.checkIntervalMs,
      cooldownMs: args.cooldownMs,
      expiresMs: args.expiresMs,
      createdAt: Date.now(),
      lastCheckedMs: 0,
      lastFiredMs: 0,
      fireCount: 0,
      lastError: null,
      consecutiveFailures: 0,
    };
    this.db
      .query(
        `INSERT INTO triggers
           (id, session_key, name, brief, source_json, predicate, state_json, status,
            one_shot, check_interval_ms, cooldown_ms, expires_ms, created_at,
            last_checked_ms, last_fired_ms, fire_count, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'armed', ?, ?, ?, ?, ?, 0, 0, 0, NULL)`,
      )
      .run(
        t.id,
        t.sessionKey,
        t.name,
        t.brief,
        JSON.stringify(t.source),
        t.predicate,
        JSON.stringify(t.state),
        t.oneShot ? 1 : 0,
        t.checkIntervalMs,
        t.cooldownMs,
        t.expiresMs,
        t.createdAt,
      );
    return t;
  }

  get(id: string): DataTrigger | null {
    const row = this.db.query("SELECT * FROM triggers WHERE id = ?").get(id) as Row | null;
    return row ? fromRow(row) : null;
  }

  listArmed(): DataTrigger[] {
    const rows = this.db
      .query("SELECT * FROM triggers WHERE status = 'armed' ORDER BY created_at ASC")
      .all() as Row[];
    return rows.map(fromRow);
  }

  listBySession(sessionKey: string, limit = 30): DataTrigger[] {
    const rows = this.db
      .query("SELECT * FROM triggers WHERE session_key = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionKey, limit) as Row[];
    return rows.map(fromRow);
  }

  markChecked(
    id: string,
    nowMs: number,
    state?: Record<string, unknown>,
    error?: string | null,
  ): void {
    const err = error ?? null;
    this.db
      .query(
        `UPDATE triggers SET last_checked_ms = ?, state_json = COALESCE(?, state_json), last_error = ?,
           consecutive_failures = CASE WHEN ? IS NULL THEN 0 ELSE consecutive_failures + 1 END
         WHERE id = ?`,
      )
      .run(nowMs, state === undefined ? null : JSON.stringify(state), err, err, id);
  }

  /** Record a fire. One-shot triggers flip to done. Returns new status. */
  recordFire(id: string, nowMs: number, state: Record<string, unknown>): TriggerStatus {
    const t = this.get(id);
    if (!t) return "canceled";
    const status: TriggerStatus = t.oneShot ? "done" : "armed";
    this.db
      .query(
        "UPDATE triggers SET last_fired_ms = ?, fire_count = fire_count + 1, state_json = ?, status = ?, last_error = NULL, consecutive_failures = 0 WHERE id = ?",
      )
      .run(nowMs, JSON.stringify(state), status, id);
    return status;
  }

  cancel(id: string, sessionKey?: string): boolean {
    const res = sessionKey
      ? this.db
          .query(
            "UPDATE triggers SET status='canceled' WHERE id=? AND session_key=? AND status='armed'",
          )
          .run(id, sessionKey)
      : this.db
          .query("UPDATE triggers SET status='canceled' WHERE id=? AND status='armed'")
          .run(id);
    return Number(res.changes) > 0;
  }

  /** Flip past-expiry armed triggers to expired. Returns how many. */
  expireSweep(nowMs: number): number {
    const res = this.db
      .query(
        "UPDATE triggers SET status='expired' WHERE status='armed' AND expires_ms IS NOT NULL AND expires_ms < ?",
      )
      .run(nowMs);
    return Number(res.changes);
  }

  countArmedBySession(sessionKey: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM triggers WHERE session_key = ? AND status = 'armed'")
      .get(sessionKey) as { n: number };
    return row.n;
  }

  /** Armed triggers across ALL sessions — the global cap's denominator. */
  countArmed(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM triggers WHERE status = 'armed'")
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

function fromRow(row: Row): DataTrigger {
  return {
    id: row.id,
    sessionKey: row.session_key,
    name: row.name,
    brief: row.brief,
    source: safeParse(row.source_json) as unknown as TriggerSource,
    predicate: row.predicate,
    state: safeParse(row.state_json),
    status: row.status as TriggerStatus,
    oneShot: row.one_shot === 1,
    checkIntervalMs: row.check_interval_ms,
    cooldownMs: row.cooldown_ms,
    expiresMs: row.expires_ms,
    createdAt: row.created_at,
    lastCheckedMs: row.last_checked_ms,
    lastFiredMs: row.last_fired_ms,
    fireCount: row.fire_count,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
