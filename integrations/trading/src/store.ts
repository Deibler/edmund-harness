import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../../src/db/open.ts";
import { genId } from "../../../src/util/ids.ts";
import type { OrderRequest, OrderStatus } from "./types.ts";

/**
 * Persistent trading state: decisions (every reasoning step), orders (with an
 * idempotency key), position/portfolio snapshots, audit log, policy history,
 * and single-row runtime flags (kill switch, daily-loss breaker). Opened via
 * the hardened `openDb` (WAL + busy_timeout + retry) so the dashboard process
 * and the daemon can both read it concurrently. Modeled on src/cron/store.ts.
 */

export type DecisionRow = {
  id: string;
  createdAt: number;
  wakeSource: string;
  policyVersion: number;
  thesis: string;
  researchRef: string | null;
  candidateJson: string | null;
  verdict: string;
  verdictReasons: string | null;
  orderId: string | null;
};

export type OrderRow = {
  id: string;
  clientOrderId: string;
  decisionId: string | null;
  symbol: string;
  side: string;
  orderType: string;
  qty: number;
  limitPrice: number | null;
  policyVersion: number;
  status: OrderStatus;
  brokerOrderId: string | null;
  submittedAt: number;
  filledAt: number | null;
  filledQty: number | null;
  avgFillPrice: number | null;
  error: string | null;
};

export class TradingStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "trading.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        wake_source TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        thesis TEXT NOT NULL,
        research_ref TEXT,
        candidate_json TEXT,
        verdict TEXT NOT NULL,
        verdict_reasons TEXT,
        order_id TEXT
      );
      CREATE INDEX IF NOT EXISTS decisions_created_idx ON decisions(created_at);

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL UNIQUE,
        decision_id TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        order_type TEXT NOT NULL,
        qty REAL NOT NULL,
        limit_price REAL,
        policy_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        broker_order_id TEXT,
        submitted_at INTEGER NOT NULL,
        filled_at INTEGER,
        filled_qty REAL,
        avg_fill_price REAL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
      CREATE INDEX IF NOT EXISTS orders_symbol_idx ON orders(symbol);

      CREATE TABLE IF NOT EXISTS positions_cache (
        symbol TEXT PRIMARY KEY,
        quantity REAL NOT NULL,
        avg_cost REAL,
        market_value REAL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taken_at INTEGER NOT NULL,
        equity REAL NOT NULL,
        cash REAL NOT NULL,
        buying_power REAL,
        day_pnl REAL
      );
      CREATE INDEX IF NOT EXISTS snapshots_taken_idx ON portfolio_snapshots(taken_at);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log(at);

      CREATE TABLE IF NOT EXISTS policy_history (
        version INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        editor TEXT NOT NULL,
        json TEXT NOT NULL,
        md TEXT
      );

      CREATE TABLE IF NOT EXISTS runtime_flags (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  // ---- runtime flags ----------------------------------------------------

  getFlag(key: string): string | null {
    const row = this.db.query("SELECT value FROM runtime_flags WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setFlag(key: string, value: string, atMs: number): void {
    this.db
      .query(
        `INSERT INTO runtime_flags (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, atMs);
  }

  getKillSwitch(): boolean {
    return this.getFlag("kill_switch") === "1";
  }

  setKillSwitch(on: boolean, atMs: number, actor: string): void {
    this.setFlag("kill_switch", on ? "1" : "0", atMs);
    this.audit(atMs, actor, on ? "kill_switch_on" : "kill_switch_off", null);
  }

  /** Daily-loss breaker is tripped if the flag holds today's date string. */
  isDailyLossTripped(todayKey: string): boolean {
    return this.getFlag("daily_loss_tripped_date") === todayKey;
  }

  tripDailyLoss(todayKey: string, atMs: number): void {
    this.setFlag("daily_loss_tripped_date", todayKey, atMs);
    this.audit(atMs, "system", "breaker_tripped", todayKey);
  }

  // ---- audit ------------------------------------------------------------

  audit(atMs: number, actor: string, event: string, detail: string | null): void {
    this.db
      .query("INSERT INTO audit_log (at, actor, event, detail) VALUES (?, ?, ?, ?)")
      .run(atMs, actor, event, detail);
  }

  listAudit(
    limit = 200,
  ): Array<{ at: number; actor: string; event: string; detail: string | null }> {
    return this.db
      .query("SELECT at, actor, event, detail FROM audit_log ORDER BY at DESC LIMIT ?")
      .all(limit) as Array<{ at: number; actor: string; event: string; detail: string | null }>;
  }

  // ---- decisions --------------------------------------------------------

  recordDecision(d: {
    createdAt: number;
    wakeSource: string;
    policyVersion: number;
    thesis: string;
    researchRef?: string | null;
    candidateJson?: string | null;
    verdict: string;
    verdictReasons?: string | null;
    orderId?: string | null;
  }): string {
    const id = genId("dec");
    this.db
      .query(
        `INSERT INTO decisions
         (id, created_at, wake_source, policy_version, thesis, research_ref, candidate_json, verdict, verdict_reasons, order_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        d.createdAt,
        d.wakeSource,
        d.policyVersion,
        d.thesis,
        d.researchRef ?? null,
        d.candidateJson ?? null,
        d.verdict,
        d.verdictReasons ?? null,
        d.orderId ?? null,
      );
    return id;
  }

  listDecisions(limit = 100): DecisionRow[] {
    const rows = this.db
      .query("SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(mapDecision);
  }

  // ---- orders -----------------------------------------------------------

  /**
   * Insert an order in `submitting` state BEFORE hitting the broker. The
   * UNIQUE client_order_id is the idempotency guard: a retry with the same
   * client id throws here instead of double-placing. Returns false if a row
   * with that client id already exists.
   */
  beginOrder(o: {
    clientOrderId: string;
    decisionId?: string | null;
    req: OrderRequest;
    qty: number;
    policyVersion: number;
    submittedAt: number;
  }): { id: string; created: boolean } {
    const existing = this.db
      .query("SELECT id FROM orders WHERE client_order_id = ?")
      .get(o.clientOrderId) as { id: string } | undefined;
    if (existing) return { id: existing.id, created: false };

    const id = genId("ord");
    this.db
      .query(
        `INSERT INTO orders
         (id, client_order_id, decision_id, symbol, side, order_type, qty, limit_price, policy_version, status, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?)`,
      )
      .run(
        id,
        o.clientOrderId,
        o.decisionId ?? null,
        o.req.symbol.toUpperCase(),
        o.req.side,
        o.req.type,
        o.qty,
        o.req.limitPrice ?? null,
        o.policyVersion,
        o.submittedAt,
      );
    return { id, created: true };
  }

  updateOrder(
    id: string,
    patch: Partial<{
      status: OrderStatus;
      brokerOrderId: string | null;
      filledAt: number | null;
      filledQty: number | null;
      avgFillPrice: number | null;
      error: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const col: Record<string, string> = {
      status: "status",
      brokerOrderId: "broker_order_id",
      filledAt: "filled_at",
      filledQty: "filled_qty",
      avgFillPrice: "avg_fill_price",
      error: "error",
    };
    for (const [k, v] of Object.entries(patch)) {
      const c = col[k];
      if (!c) continue;
      sets.push(`${c} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.query(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as never[]));
  }

  getOrder(id: string): OrderRow | null {
    const row = this.db.query("SELECT * FROM orders WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapOrder(row) : null;
  }

  listOrders(opts: { status?: OrderStatus; limit?: number } = {}): OrderRow[] {
    const limit = opts.limit ?? 100;
    const rows = opts.status
      ? (this.db
          .query("SELECT * FROM orders WHERE status = ? ORDER BY submitted_at DESC LIMIT ?")
          .all(opts.status, limit) as Array<Record<string, unknown>>)
      : (this.db
          .query("SELECT * FROM orders ORDER BY submitted_at DESC LIMIT ?")
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map(mapOrder);
  }

  /** Orders placed today (any status) — for the maxTradesPerDay limit. */
  countOrdersSince(sinceMs: number): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM orders WHERE submitted_at >= ?")
      .get(sinceMs) as { n: number };
    return row.n;
  }

  // ---- snapshots --------------------------------------------------------

  recordSnapshot(s: {
    takenAt: number;
    equity: number;
    cash: number;
    buyingPower?: number | null;
    dayPnL?: number | null;
  }): void {
    this.db
      .query(
        "INSERT INTO portfolio_snapshots (taken_at, equity, cash, buying_power, day_pnl) VALUES (?, ?, ?, ?, ?)",
      )
      .run(s.takenAt, s.equity, s.cash, s.buyingPower ?? null, s.dayPnL ?? null);
  }

  latestSnapshot(): {
    takenAt: number;
    equity: number;
    cash: number;
    buyingPower: number | null;
    dayPnL: number | null;
  } | null {
    const row = this.db
      .query(
        "SELECT taken_at AS takenAt, equity, cash, buying_power AS buyingPower, day_pnl AS dayPnL FROM portfolio_snapshots ORDER BY taken_at DESC LIMIT 1",
      )
      .get() as {
      takenAt: number;
      equity: number;
      cash: number;
      buyingPower: number | null;
      dayPnL: number | null;
    } | null;
    return row ?? null;
  }

  // ---- policy history ---------------------------------------------------

  recordPolicyVersion(
    version: number,
    atMs: number,
    editor: string,
    json: string,
    md: string,
  ): void {
    this.db
      .query(
        `INSERT INTO policy_history (version, at, editor, json, md) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(version) DO UPDATE SET at = excluded.at, editor = excluded.editor, json = excluded.json, md = excluded.md`,
      )
      .run(version, atMs, editor, json, md);
  }

  close(): void {
    this.db.close();
  }
}

function mapDecision(r: Record<string, unknown>): DecisionRow {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    wakeSource: r.wake_source as string,
    policyVersion: r.policy_version as number,
    thesis: r.thesis as string,
    researchRef: (r.research_ref as string) ?? null,
    candidateJson: (r.candidate_json as string) ?? null,
    verdict: r.verdict as string,
    verdictReasons: (r.verdict_reasons as string) ?? null,
    orderId: (r.order_id as string) ?? null,
  };
}

function mapOrder(r: Record<string, unknown>): OrderRow {
  return {
    id: r.id as string,
    clientOrderId: r.client_order_id as string,
    decisionId: (r.decision_id as string) ?? null,
    symbol: r.symbol as string,
    side: r.side as string,
    orderType: r.order_type as string,
    qty: r.qty as number,
    limitPrice: (r.limit_price as number) ?? null,
    policyVersion: r.policy_version as number,
    status: r.status as OrderStatus,
    brokerOrderId: (r.broker_order_id as string) ?? null,
    submittedAt: r.submitted_at as number,
    filledAt: (r.filled_at as number) ?? null,
    filledQty: (r.filled_qty as number) ?? null,
    avgFillPrice: (r.avg_fill_price as number) ?? null,
    error: (r.error as string) ?? null,
  };
}
