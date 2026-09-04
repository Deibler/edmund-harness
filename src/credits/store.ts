import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";

/**
 * Per-person generation credits — the little that has to live locally.
 *
 * Money is NOT bookkept here. OpenRouter holds each person's key and its
 * limit, usage and remaining; Stripe holds every payment. Both are read
 * live whenever a page opens or Edmund is about to generate (see sync.ts).
 * What cannot come from either of them, and so lives in state.db:
 *
 *   credit_wallets  session → the minted key (OpenRouter returns the
 *                   plaintext exactly once), its hash, and the per-person
 *                   override `billing_mode` (`house` = generate on the
 *                   global key exactly as before). The `last_seen_*`
 *                   columns are a display snapshot for the operator's list
 *                   when a live read fails; nothing decides from them.
 *   credit_events   the paywall saying no — refusals, which neither Stripe
 *                   nor OpenRouter ever saw. Generations that went through
 *                   are NOT written here: OpenRouter is the record of those
 *                   (analytics.ts) and the statement reads them back live.
 *
 * An older `credit_payments` table may exist from the first day; it is no
 * longer read or written.
 */

export type BillingMode = "wallet" | "house";
export type GenerationKind = "image" | "video" | "audio";

export type Wallet = {
  sessionKey: string;
  billingMode: BillingMode;
  keyHash: string | null;
  apiKey: string | null;
  createdAtMs: number;
  starterUsd: number;
  lastSeenUsageUsd: number | null;
  lastSeenRemainingUsd: number | null;
  lastSeenLimitUsd: number | null;
  lastSeenAtMs: number | null;
  disabled: boolean;
};

/** The paywall saying no, and why — the hits the operator wants to see. */
export type CreditEventKind =
  | "refused-exhausted"
  | "refused-short"
  | "refused-unavailable"
  | "refused-disabled"
  | "refused-account";

export type CreditEvent = {
  id: number;
  sessionKey: string;
  kind: CreditEventKind;
  generation: GenerationKind;
  atMs: number;
  remainingUsd: number | null;
  /** Usage delta measured on the key at the time; the live figure comes
   *  from OpenRouter's generation record (activity.ts). */
  costUsd: number | null;
  detail: string | null;
  /** The OpenRouter model slug that ran (or was asked for). */
  model: string | null;
  /** OpenRouter's id for the generation — the pointer into their ledger. */
  generationId: string | null;
};

export type CreditEventSummary = {
  paywallHits: number;
  lastPaywallAtMs: number | null;
  lastPaywallGeneration: GenerationKind | null;
};

type WalletRow = {
  session_key: string;
  billing_mode: string;
  key_hash: string | null;
  api_key: string | null;
  created_at_ms: number;
  starter_usd: number;
  last_seen_usage_usd: number | null;
  last_seen_remaining_usd: number | null;
  last_seen_limit_usd: number | null;
  last_seen_at_ms: number | null;
  disabled: number;
};

type EventRow = {
  id: number;
  session_key: string;
  kind: string;
  generation: string;
  at_ms: number;
  remaining_usd: number | null;
  cost_usd: number | null;
  detail: string | null;
  model: string | null;
  generation_id: string | null;
};

export class CreditStore {
  private db: Database;
  private stmtCache = new Map<string, ReturnType<Database["query"]>>();

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
    this.db = openDb(join(dataDir, "state.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credit_wallets (
        session_key             TEXT PRIMARY KEY,
        billing_mode            TEXT NOT NULL DEFAULT 'wallet',
        key_hash                TEXT,
        api_key                 TEXT,
        created_at_ms           INTEGER NOT NULL,
        starter_usd             REAL NOT NULL DEFAULT 0,
        paid_total_usd          REAL NOT NULL DEFAULT 0,
        credited_total_usd      REAL NOT NULL DEFAULT 0,
        last_seen_usage_usd     REAL,
        last_seen_remaining_usd REAL,
        last_seen_limit_usd     REAL,
        last_seen_at_ms         INTEGER,
        disabled                INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS credit_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key   TEXT NOT NULL,
        kind          TEXT NOT NULL,
        generation    TEXT NOT NULL,
        at_ms         INTEGER NOT NULL,
        remaining_usd REAL,
        cost_usd      REAL,
        detail        TEXT
      );
      CREATE INDEX IF NOT EXISTS credit_events_session_idx
        ON credit_events(session_key, at_ms DESC);
      CREATE INDEX IF NOT EXISTS credit_events_at_idx
        ON credit_events(at_ms DESC);
    `);
    // Added after the first deploy: which model ran and OpenRouter's id for
    // the generation, so the cost can be read back from OpenRouter later.
    const cols = (
      this.db.query("PRAGMA table_info(credit_events)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!cols.includes("model")) this.db.exec("ALTER TABLE credit_events ADD COLUMN model TEXT");
    if (!cols.includes("generation_id")) {
      this.db.exec("ALTER TABLE credit_events ADD COLUMN generation_id TEXT");
    }
    // For one day (2026-09-02) a row was written for every generation that
    // went through. OpenRouter is the record of those; the copies go.
    this.db.exec("DELETE FROM credit_events WHERE kind = 'charged'");
  }

  // ── wallets ──────────────────────────────────────────────────────

  get(sessionKey: string): Wallet | null {
    const row = this.q("SELECT * FROM credit_wallets WHERE session_key = ?").get(
      sessionKey,
    ) as WalletRow | null;
    return row ? rowToWallet(row) : null;
  }

  /** The row for a session, created (mode `wallet`, no key) if missing. */
  ensure(sessionKey: string, nowMs = Date.now()): Wallet {
    const existing = this.get(sessionKey);
    if (existing) return existing;
    this.q(
      `INSERT INTO credit_wallets (session_key, billing_mode, created_at_ms)
       VALUES (?, 'wallet', ?)
       ON CONFLICT(session_key) DO NOTHING`,
    ).run(sessionKey, nowMs);
    return this.get(sessionKey)!;
  }

  list(): Wallet[] {
    const rows = this.q(
      "SELECT * FROM credit_wallets ORDER BY created_at_ms DESC",
    ).all() as WalletRow[];
    return rows.map(rowToWallet);
  }

  setMode(sessionKey: string, mode: BillingMode): Wallet {
    this.ensure(sessionKey);
    this.q("UPDATE credit_wallets SET billing_mode = ? WHERE session_key = ?").run(
      mode,
      sessionKey,
    );
    return this.get(sessionKey)!;
  }

  /** Record the one-time plaintext key and its hash after minting. */
  attachKey(
    sessionKey: string,
    key: { hash: string; apiKey: string; limitUsd: number; starterUsd: number },
    nowMs = Date.now(),
  ): Wallet {
    this.ensure(sessionKey, nowMs);
    this.q(
      `UPDATE credit_wallets
          SET key_hash = ?, api_key = ?, starter_usd = ?,
              last_seen_limit_usd = ?, last_seen_remaining_usd = ?, last_seen_usage_usd = 0,
              last_seen_at_ms = ?
        WHERE session_key = ?`,
    ).run(key.hash, key.apiKey, key.starterUsd, key.limitUsd, key.limitUsd, nowMs, sessionKey);
    return this.get(sessionKey)!;
  }

  /** Display-only snapshot of what OpenRouter reported. Never decided from. */
  recordSeen(
    sessionKey: string,
    seen: { usageUsd: number | null; remainingUsd: number | null; limitUsd: number | null },
    nowMs = Date.now(),
  ): void {
    this.q(
      `UPDATE credit_wallets
          SET last_seen_usage_usd = ?, last_seen_remaining_usd = ?, last_seen_limit_usd = ?,
              last_seen_at_ms = ?
        WHERE session_key = ?`,
    ).run(seen.usageUsd, seen.remainingUsd, seen.limitUsd, nowMs, sessionKey);
  }

  setDisabled(sessionKey: string, disabled: boolean): void {
    this.q("UPDATE credit_wallets SET disabled = ? WHERE session_key = ?").run(
      disabled ? 1 : 0,
      sessionKey,
    );
  }

  // ── events: what the paywall actually did to people ──────────────

  recordEvent(e: {
    sessionKey: string;
    kind: CreditEventKind;
    generation: GenerationKind;
    remainingUsd?: number | null;
    costUsd?: number | null;
    detail?: string | null;
    model?: string | null;
    generationId?: string | null;
    atMs?: number;
  }): void {
    this.q(
      `INSERT INTO credit_events
         (session_key, kind, generation, at_ms, remaining_usd, cost_usd, detail, model, generation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.sessionKey,
      e.kind,
      e.generation,
      e.atMs ?? Date.now(),
      e.remainingUsd ?? null,
      e.costUsd ?? null,
      e.detail?.slice(0, 300) ?? null,
      e.model ?? null,
      e.generationId ?? null,
    );
  }

  eventsFor(sessionKey: string, limit = 50): CreditEvent[] {
    const rows = this.q(
      `SELECT * FROM credit_events WHERE session_key = ? ORDER BY at_ms DESC, id DESC LIMIT ?`,
    ).all(sessionKey, limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  /** Newest events across everyone; `refusalsOnly` = just the paywall hits. */
  recentEvents(limit = 50, refusalsOnly = false): CreditEvent[] {
    const rows = (
      refusalsOnly
        ? this.q(
            `SELECT * FROM credit_events WHERE kind LIKE 'refused-%'
              ORDER BY at_ms DESC, id DESC LIMIT ?`,
          ).all(limit)
        : this.q(`SELECT * FROM credit_events ORDER BY at_ms DESC, id DESC LIMIT ?`).all(limit)
    ) as EventRow[];
    return rows.map(rowToEvent);
  }

  /** Per-session rollup for the dashboard table. */
  eventSummaries(): Map<string, CreditEventSummary> {
    const rows = this.q(
      `SELECT session_key,
              SUM(CASE WHEN kind LIKE 'refused-%' THEN 1 ELSE 0 END)           AS hits,
              MAX(CASE WHEN kind LIKE 'refused-%' THEN at_ms END)              AS last_hit
         FROM credit_events GROUP BY session_key`,
    ).all() as Array<{
      session_key: string;
      hits: number;
      last_hit: number | null;
    }>;
    const out = new Map<string, CreditEventSummary>();
    for (const r of rows) {
      let lastHitGeneration: GenerationKind | null = null;
      if (r.last_hit !== null) {
        const last = this.q(
          `SELECT generation FROM credit_events
            WHERE session_key = ? AND kind LIKE 'refused-%' ORDER BY at_ms DESC, id DESC LIMIT 1`,
        ).get(r.session_key) as { generation: string } | null;
        lastHitGeneration = (last?.generation as GenerationKind | undefined) ?? null;
      }
      out.set(r.session_key, {
        paywallHits: r.hits,
        lastPaywallAtMs: r.last_hit,
        lastPaywallGeneration: lastHitGeneration,
      });
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}

function rowToWallet(r: WalletRow): Wallet {
  return {
    sessionKey: r.session_key,
    billingMode: r.billing_mode === "house" ? "house" : "wallet",
    keyHash: r.key_hash,
    apiKey: r.api_key,
    createdAtMs: r.created_at_ms,
    starterUsd: r.starter_usd,
    lastSeenUsageUsd: r.last_seen_usage_usd,
    lastSeenRemainingUsd: r.last_seen_remaining_usd,
    lastSeenLimitUsd: r.last_seen_limit_usd,
    lastSeenAtMs: r.last_seen_at_ms,
    disabled: r.disabled === 1,
  };
}

function rowToEvent(r: EventRow): CreditEvent {
  return {
    id: r.id,
    sessionKey: r.session_key,
    kind: r.kind as CreditEventKind,
    generation: r.generation as GenerationKind,
    atMs: r.at_ms,
    remainingUsd: r.remaining_usd,
    costUsd: r.cost_usd,
    detail: r.detail,
    model: r.model ?? null,
    generationId: r.generation_id ?? null,
  };
}
