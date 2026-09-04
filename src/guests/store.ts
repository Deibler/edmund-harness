import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { normalizeHandle } from "../sessions/key.ts";

/**
 * Guest-access persistence — everything the keyed-guest gate needs to
 * remember across restarts. See docs/design/guest-access-plan.md.
 *
 * Lives in state.db (the GhostPrefsStore pattern: a second store class
 * owning its own tables on the shared DB) so the daemon, CLI, and dashboard
 * share one source of truth — and buffered stranger messages inherit the
 * path-safety denylist that already protects state.db from tool access.
 *
 * Tables:
 *   guest_activations — handle → campaign key, written the moment a buffered
 *                       unknown sender presents an active key.
 *   vouched_handles   — handles that share a registered group with the bot.
 *                       Vouching is by co-membership, not by being replied to.
 *   buffered_messages — what an unknown DM sender said before (if ever)
 *                       presenting a key. Capped per handle + TTL'd, and
 *                       drained into the first guest turn as untrusted context.
 *   key_attempts      — unknown-DM messages that matched no key, for the
 *                       dashboard / decisions log. Never shown to the model.
 *   guest_message_log — one row per processed guest/vouched inbound; the
 *                       rolling per-handle rate limit counts this.
 *   campaign_daily    — (day, campaign) rollup for max_messages_per_day,
 *                       kept in the same write like spend_daily.
 *   cap_notices       — which cap declines have already been sent, so a
 *                       capped guest gets ONE polite decline, then silence.
 *
 * All handles are stored normalized (normalizeHandle) and campaign keys
 * lowercased, so lookups never depend on how IMCore spelled the address.
 */

/** Keep at most this many buffered messages per unknown handle. */
export const BUFFER_KEEP_PER_HANDLE = 20;
/** Drop buffered messages older than this. */
const BUFFER_TTL_MS = 14 * 24 * 3_600_000;

export type GuestActivation = {
  handle: string;
  campaignKey: string;
  activatedAtMs: number;
};

export type BufferedMessage = {
  text: string;
  atMs: number;
};

export class GuestStore {
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
      CREATE TABLE IF NOT EXISTS guest_activations (
        handle          TEXT PRIMARY KEY,
        campaign_key    TEXT NOT NULL,
        activated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vouched_handles (
        handle       TEXT PRIMARY KEY,
        chat_guid    TEXT NOT NULL,
        vouched_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS buffered_messages (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        handle TEXT NOT NULL,
        text   TEXT NOT NULL,
        at_ms  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_buffered_handle ON buffered_messages(handle, at_ms);
      CREATE TABLE IF NOT EXISTS key_attempts (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        handle TEXT NOT NULL,
        at_ms  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guest_message_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        handle       TEXT NOT NULL,
        campaign_key TEXT,
        at_ms        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_guest_msg_handle ON guest_message_log(handle, at_ms);
      CREATE TABLE IF NOT EXISTS campaign_daily (
        day          TEXT NOT NULL,
        campaign_key TEXT NOT NULL,
        messages     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, campaign_key)
      );
      CREATE TABLE IF NOT EXISTS cap_notices (
        scope TEXT PRIMARY KEY,
        at_ms INTEGER NOT NULL
      );
    `);
  }

  // ─── Activations ────────────────────────────────────────────────────

  getActivation(handle: string): GuestActivation | null {
    const row = this.q(
      "SELECT handle, campaign_key AS campaignKey, activated_at_ms AS activatedAtMs FROM guest_activations WHERE handle = ?",
    ).get(normalizeHandle(handle)) as GuestActivation | undefined;
    return row ?? null;
  }

  /** Persist a key activation. A re-activation with a different key wins —
   *  the sender deliberately typed a new one. */
  activate(handle: string, campaignKey: string, nowMs = Date.now()): void {
    this.q(
      `INSERT INTO guest_activations (handle, campaign_key, activated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         campaign_key = excluded.campaign_key,
         activated_at_ms = excluded.activated_at_ms`,
    ).run(normalizeHandle(handle), campaignKey.trim().toLowerCase(), nowMs);
  }

  // ─── Vouching ───────────────────────────────────────────────────────

  /** Record every participant of a registered group as vouched. Idempotent;
   *  the first vouching group wins (only for provenance — any registered
   *  group is as good as any other). */
  recordVouches(handles: string[], chatGuid: string, nowMs = Date.now()): void {
    const stmt = this.q(
      "INSERT OR IGNORE INTO vouched_handles (handle, chat_guid, vouched_at_ms) VALUES (?, ?, ?)",
    );
    for (const h of handles) {
      const norm = normalizeHandle(h);
      if (norm) stmt.run(norm, chatGuid, nowMs);
    }
  }

  isVouched(handle: string): boolean {
    const row = this.q("SELECT 1 FROM vouched_handles WHERE handle = ? LIMIT 1").get(
      normalizeHandle(handle),
    );
    return row !== undefined && row !== null;
  }

  // ─── Unknown-sender buffer ──────────────────────────────────────────

  /** Buffer an unknown sender's message, keeping the last
   *  BUFFER_KEEP_PER_HANDLE per handle and dropping anything past the TTL. */
  bufferMessage(handle: string, text: string, nowMs = Date.now()): void {
    const norm = normalizeHandle(handle);
    this.q("INSERT INTO buffered_messages (handle, text, at_ms) VALUES (?, ?, ?)").run(
      norm,
      text,
      nowMs,
    );
    this.q(
      `DELETE FROM buffered_messages
       WHERE handle = ? AND id NOT IN (
         SELECT id FROM buffered_messages WHERE handle = ? ORDER BY at_ms DESC, id DESC LIMIT ?
       )`,
    ).run(norm, norm, BUFFER_KEEP_PER_HANDLE);
    this.q("DELETE FROM buffered_messages WHERE at_ms < ?").run(nowMs - BUFFER_TTL_MS);
  }

  /** Pull-and-clear the buffered pre-key messages for a handle, oldest
   *  first. Called once when the activating turn assembles its envelope. */
  drainBuffered(handle: string): BufferedMessage[] {
    const norm = normalizeHandle(handle);
    const rows = this.q(
      "SELECT text, at_ms AS atMs FROM buffered_messages WHERE handle = ? ORDER BY at_ms ASC, id ASC",
    ).all(norm) as BufferedMessage[];
    this.q("DELETE FROM buffered_messages WHERE handle = ?").run(norm);
    return rows;
  }

  /** A no-key unknown-DM attempt, for the dashboard / decisions log. */
  recordAttempt(handle: string, nowMs = Date.now()): void {
    this.q("INSERT INTO key_attempts (handle, at_ms) VALUES (?, ?)").run(
      normalizeHandle(handle),
      nowMs,
    );
  }

  listAttempts(limit = 100): Array<{ handle: string; atMs: number }> {
    return this.q("SELECT handle, at_ms AS atMs FROM key_attempts ORDER BY at_ms DESC LIMIT ?").all(
      limit,
    ) as Array<{ handle: string; atMs: number }>;
  }

  // ─── Caps ───────────────────────────────────────────────────────────

  /** Log a processed guest/vouched inbound; bumps the campaign's daily
   *  rollup in the same write when a campaign is involved. */
  recordGuestMessage(
    handle: string,
    campaignKey: string | null,
    day: string,
    nowMs = Date.now(),
  ): void {
    const key = campaignKey?.trim().toLowerCase() ?? null;
    this.q("INSERT INTO guest_message_log (handle, campaign_key, at_ms) VALUES (?, ?, ?)").run(
      normalizeHandle(handle),
      key,
      nowMs,
    );
    if (key) {
      this.q(
        `INSERT INTO campaign_daily (day, campaign_key, messages) VALUES (?, ?, 1)
         ON CONFLICT(day, campaign_key) DO UPDATE SET messages = messages + 1`,
      ).run(day, key);
    }
  }

  /** Rolling-window message count for the per-handle rate limit. */
  countRecentMessages(handle: string, sinceMs: number): number {
    const row = this.q(
      "SELECT COUNT(*) AS n FROM guest_message_log WHERE handle = ? AND at_ms >= ?",
    ).get(normalizeHandle(handle), sinceMs) as { n: number };
    return row.n;
  }

  /** Messages processed for a campaign on a given local day. */
  countCampaignDay(campaignKey: string, day: string): number {
    const row = this.q(
      "SELECT messages FROM campaign_daily WHERE day = ? AND campaign_key = ?",
    ).get(day, campaignKey.trim().toLowerCase()) as { messages: number } | null;
    return row?.messages ?? 0;
  }

  /** First cap hit for `scope` returns true (send the one polite decline +
   *  operator alert); every later hit returns false (stay silent). */
  capNoticeOnce(scope: string, nowMs = Date.now()): boolean {
    const res = this.q("INSERT OR IGNORE INTO cap_notices (scope, at_ms) VALUES (?, ?)").run(
      scope,
      nowMs,
    );
    return Number(res.changes) > 0;
  }

  /** Re-arm a cap notice once its condition has cleared (e.g. the rolling
   *  rate window emptied), so a LATER cap hit declines politely again. */
  clearCapNotice(scope: string): void {
    this.q("DELETE FROM cap_notices WHERE scope = ?").run(scope);
  }

  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }
}

// ─── Singleton (per data dir) ─────────────────────────────────────────
// The runner derives the guest loadout on EVERY runClaude call (turn,
// recovery, cron fire) — one shared handle per data dir, same shape as
// getSpendLedger.

const stores = new Map<string, GuestStore>();

export function getGuestStore(dataDir: string): GuestStore {
  let s = stores.get(dataDir);
  if (!s) {
    s = new GuestStore(dataDir);
    stores.set(dataDir, s);
  }
  return s;
}
