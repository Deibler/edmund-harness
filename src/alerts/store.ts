import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";

/**
 * Persistent log of operator alerts. Lets the dashboard show "what fired
 * lately" instead of relying on grep over daemon.log, and gives a place
 * to record per-category mutes that persist across daemon restarts.
 *
 * Append-only on the alerts table; the mutes table holds at most one row
 * per category.
 */
export type AlertRow = {
  id: number;
  category: string;
  signature: string;
  text: string;
  context: string | null;
  firedAtMs: number;
  delivered: boolean;
};

export type AlertMute = {
  category: string;
  untilMs: number;
};

export class AlertStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "alerts.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        signature TEXT NOT NULL,
        text TEXT NOT NULL,
        context TEXT,
        fired_at_ms INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS alerts_fired_idx ON alerts(fired_at_ms);
      CREATE TABLE IF NOT EXISTS alert_mutes (
        category TEXT PRIMARY KEY,
        until_ms INTEGER NOT NULL
      );
    `);
  }

  record(input: {
    category: string;
    signature: string;
    text: string;
    context: string | null;
    delivered: boolean;
  }): void {
    this.db
      .query(
        "INSERT INTO alerts(category, signature, text, context, fired_at_ms, delivered) VALUES (?,?,?,?,?,?)",
      )
      .run(
        input.category,
        input.signature,
        input.text,
        input.context,
        Date.now(),
        input.delivered ? 1 : 0,
      );
  }

  listRecent(limit = 200): AlertRow[] {
    const rows = this.db
      .query("SELECT * FROM alerts ORDER BY fired_at_ms DESC LIMIT ?")
      .all(limit) as Array<{
      id: number;
      category: string;
      signature: string;
      text: string;
      context: string | null;
      fired_at_ms: number;
      delivered: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      signature: r.signature,
      text: r.text,
      context: r.context,
      firedAtMs: r.fired_at_ms,
      delivered: !!r.delivered,
    }));
  }

  isMuted(category: string, now = Date.now()): boolean {
    const row = this.db
      .query("SELECT until_ms FROM alert_mutes WHERE category = ?")
      .get(category) as { until_ms: number } | undefined;
    return !!row && row.until_ms > now;
  }

  setMute(category: string, untilMs: number): void {
    this.db
      .query(
        "INSERT INTO alert_mutes(category, until_ms) VALUES (?,?) ON CONFLICT(category) DO UPDATE SET until_ms = excluded.until_ms",
      )
      .run(category, untilMs);
  }

  clearMute(category: string): void {
    this.db.query("DELETE FROM alert_mutes WHERE category = ?").run(category);
  }

  listMutes(): AlertMute[] {
    const rows = this.db.query("SELECT * FROM alert_mutes").all() as Array<{
      category: string;
      until_ms: number;
    }>;
    return rows.map((r) => ({ category: r.category, untilMs: r.until_ms }));
  }

  close(): void {
    this.db.close();
  }
}
