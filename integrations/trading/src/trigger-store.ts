import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../../src/db/open.ts";
import { genId } from "../../../src/util/ids.ts";

/**
 * Price triggers — "wake the trading session when SYMBOL crosses THRESHOLD".
 * Polled by the TriggerWatcher (src/trading/trigger-watcher.ts). One-shot by
 * default (status → 'fired'); the trading session re-arms by registering a new
 * one. Stored in triggers.db via the hardened openDb. Modeled on cron/store.ts.
 */

export type TriggerDirection = "above" | "below";
type TriggerStatus = "armed" | "fired" | "canceled";

export type PriceTrigger = {
  id: string;
  sessionKey: string;
  symbol: string;
  direction: TriggerDirection;
  threshold: number;
  note: string | null;
  status: TriggerStatus;
  createdAt: number;
  lastCheckedMs: number | null;
  firedAtMs: number | null;
};

export class TriggerStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "triggers.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_triggers (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        threshold REAL NOT NULL,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'armed',
        created_at INTEGER NOT NULL,
        last_checked_ms INTEGER,
        fired_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS triggers_status_idx ON price_triggers(status);
      CREATE INDEX IF NOT EXISTS triggers_session_idx ON price_triggers(session_key);
    `);
  }

  create(t: {
    sessionKey: string;
    symbol: string;
    direction: TriggerDirection;
    threshold: number;
    note?: string | null;
  }): PriceTrigger {
    const id = genId("trig");
    const createdAt = Date.now();
    this.db
      .query(
        `INSERT INTO price_triggers (id, session_key, symbol, direction, threshold, note, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'armed', ?)`,
      )
      .run(
        id,
        t.sessionKey,
        t.symbol.toUpperCase(),
        t.direction,
        t.threshold,
        t.note ?? null,
        createdAt,
      );
    return {
      id,
      sessionKey: t.sessionKey,
      symbol: t.symbol.toUpperCase(),
      direction: t.direction,
      threshold: t.threshold,
      note: t.note ?? null,
      status: "armed",
      createdAt,
      lastCheckedMs: null,
      firedAtMs: null,
    };
  }

  listArmed(): PriceTrigger[] {
    return (
      this.db.query("SELECT * FROM price_triggers WHERE status = 'armed'").all() as Array<
        Record<string, unknown>
      >
    ).map(map);
  }

  /** Distinct armed symbols, for a batched quote fetch. */
  armedSymbols(): string[] {
    const rows = this.db
      .query("SELECT DISTINCT symbol FROM price_triggers WHERE status = 'armed'")
      .all() as Array<{ symbol: string }>;
    return rows.map((r) => r.symbol);
  }

  listForSession(sessionKey: string): PriceTrigger[] {
    return (
      this.db
        .query("SELECT * FROM price_triggers WHERE session_key = ? ORDER BY created_at DESC")
        .all(sessionKey) as Array<Record<string, unknown>>
    ).map(map);
  }

  markChecked(id: string, atMs: number): void {
    this.db.query("UPDATE price_triggers SET last_checked_ms = ? WHERE id = ?").run(atMs, id);
  }

  markFired(id: string, atMs: number): void {
    this.db
      .query(
        "UPDATE price_triggers SET status = 'fired', fired_at_ms = ? WHERE id = ? AND status = 'armed'",
      )
      .run(atMs, id);
  }

  cancel(id: string, sessionKey?: string): boolean {
    const res = sessionKey
      ? this.db
          .query(
            "UPDATE price_triggers SET status = 'canceled' WHERE id = ? AND session_key = ? AND status = 'armed'",
          )
          .run(id, sessionKey)
      : this.db
          .query("UPDATE price_triggers SET status = 'canceled' WHERE id = ? AND status = 'armed'")
          .run(id);
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

function map(r: Record<string, unknown>): PriceTrigger {
  return {
    id: r.id as string,
    sessionKey: r.session_key as string,
    symbol: r.symbol as string,
    direction: r.direction as TriggerDirection,
    threshold: r.threshold as number,
    note: (r.note as string) ?? null,
    status: r.status as TriggerStatus,
    createdAt: r.created_at as number,
    lastCheckedMs: (r.last_checked_ms as number) ?? null,
    firedAtMs: (r.fired_at_ms as number) ?? null,
  };
}
