import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import type { HistoryLine } from "../imessage/history.ts";
import { normalizeHandle } from "../sessions/key.ts";

/**
 * SMS persistence — conversation-keyed, so DMs and group texts share one
 * schema instead of groups being bolted onto a handle-keyed table later.
 *
 * `conversation` is the normalized phone number for a DM and the Twilio
 * Conversation SID (`CH…`) for a group. The two value spaces cannot collide
 * (one starts with `+` or a digit, the other with `CH`), and every query in
 * this store takes the conversation id, never a bare handle.
 *
 * Four jobs:
 *
 * **1. The transcript.** chat.db is the system of record for iMessage and
 * knows nothing about Twilio traffic. Without a transcript here, an SMS
 * conversation would present as a cold start on every turn. `recentLines`
 * returns the same `HistoryLine` shape chat.db produces so the envelope
 * renders one way for both channels — including `fromHandle` per group
 * member, which is what makes speaker attribution work in a group text.
 *
 * **2. Consent state.** The legally load-bearing part. Twilio's Advanced
 * Opt-Out answers STOP at the messaging-service layer, but that is THEIR
 * copy of the state and our send path does not consult it. Keeping consent
 * here means the harness refuses on its own — a cron fire or proactive nudge
 * cannot text someone who opted out. A guard taken on one path is not a
 * guard. Consent is per PERSON (handle), not per conversation: STOP from a
 * number silences us to that number everywhere, including in groups.
 *
 * **3. Group membership.** Who is in a Conversation, per Twilio's webhooks.
 * Used to render the participant list and to distinguish "reply to the
 * group" from "reply to the person". Membership rows are upserts from
 * webhook state, never inferences.
 *
 * **4. Webhook idempotency.** Twilio retries any webhook not answered 2xx
 * quickly; a retried inbound must not become a second model turn. Dedup is
 * on Twilio's own message identifier rather than a body hash, because "ok"
 * sent twice on purpose is a real message and must not be swallowed.
 */

/** Rows older than this are pruned from the transcript on open. */
const TRANSCRIPT_TTL_MS = 90 * 24 * 3_600_000;
/** Seen-id rows only need to outlive Twilio's retry window. */
const SEEN_TTL_MS = 24 * 3_600_000;

export type SmsDirection = "in" | "out";

export type ConsentVerdict =
  | { allowed: true }
  | { allowed: false; reason: "opted-out"; sinceMs: number };

export type GroupInfo = {
  conversationSid: string;
  friendlyName: string | null;
  /** Normalized phone numbers of the human participants (never our own number). */
  participants: string[];
};

export class SmsStore {
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
      CREATE TABLE IF NOT EXISTS sms_messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation TEXT NOT NULL,
        from_handle  TEXT NOT NULL DEFAULT '',
        direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
        body         TEXT NOT NULL,
        message_sid  TEXT,
        at_ms        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sms_messages_conv_at
        ON sms_messages (conversation, at_ms DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_sid
        ON sms_messages (message_sid) WHERE message_sid IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sms_consent (
        handle       TEXT PRIMARY KEY,
        opted_out    INTEGER NOT NULL DEFAULT 0,
        changed_ms   INTEGER NOT NULL,
        last_keyword TEXT
      );

      CREATE TABLE IF NOT EXISTS sms_groups (
        conversation_sid TEXT PRIMARY KEY,
        friendly_name    TEXT,
        updated_ms       INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sms_group_members (
        conversation_sid TEXT NOT NULL,
        handle           TEXT NOT NULL,
        PRIMARY KEY (conversation_sid, handle)
      );

      CREATE TABLE IF NOT EXISTS sms_conversations (
        conversation_sid TEXT PRIMARY KEY,
        kind             TEXT NOT NULL CHECK (kind IN ('dm','group')),
        peer_handle      TEXT,
        seen_ms          INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sms_spend (
        message_sid  TEXT PRIMARY KEY,
        direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
        counterparty TEXT NOT NULL,
        segments     INTEGER NOT NULL DEFAULT 1,
        est_usd      REAL NOT NULL,
        actual_usd   REAL,
        at_ms        INTEGER NOT NULL,
        reconciled_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS sms_spend_at ON sms_spend (at_ms DESC);

      CREATE TABLE IF NOT EXISTS sms_seen (
        message_sid TEXT PRIMARY KEY,
        at_ms       INTEGER NOT NULL
      );
    `);
    this.prune();
  }

  private prune(): void {
    const now = Date.now();
    this.db.run("DELETE FROM sms_messages WHERE at_ms < ?", [now - TRANSCRIPT_TTL_MS]);
    this.db.run("DELETE FROM sms_seen WHERE at_ms < ?", [now - SEEN_TTL_MS]);
  }

  // ── idempotency ────────────────────────────────────────────────────────
  /**
   * Claim an inbound message id. True on the FIRST claim, false on a retry.
   * The insert itself is the lock — check-then-insert would leave a window
   * where two concurrent deliveries of one retry both enqueue a turn.
   */
  claimInbound(messageSid: string): boolean {
    if (!messageSid) return true;
    const res = this.db.run("INSERT OR IGNORE INTO sms_seen (message_sid, at_ms) VALUES (?, ?)", [
      messageSid,
      Date.now(),
    ]);
    return res.changes > 0;
  }

  // ── consent (per person, everywhere) ───────────────────────────────────
  setOptedOut(handle: string, keyword: string, atMs = Date.now()): void {
    this.db.run(
      `INSERT INTO sms_consent (handle, opted_out, changed_ms, last_keyword)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET opted_out = 1, changed_ms = ?, last_keyword = ?`,
      [normalizeHandle(handle), atMs, keyword, atMs, keyword],
    );
  }

  setOptedIn(handle: string, keyword: string, atMs = Date.now()): void {
    this.db.run(
      `INSERT INTO sms_consent (handle, opted_out, changed_ms, last_keyword)
       VALUES (?, 0, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET opted_out = 0, changed_ms = ?, last_keyword = ?`,
      [normalizeHandle(handle), atMs, keyword, atMs, keyword],
    );
  }

  isOptedOut(handle: string): boolean {
    const row = this.q("SELECT opted_out FROM sms_consent WHERE handle = ?").get(
      normalizeHandle(handle),
    ) as { opted_out: number } | undefined;
    return row?.opted_out === 1;
  }

  /**
   * May we send to this DM handle right now? Absence of a row means allowed:
   * someone who texted first consented by doing so; this table records only
   * explicit revocation.
   */
  checkConsent(handle: string): ConsentVerdict {
    const row = this.q("SELECT opted_out, changed_ms FROM sms_consent WHERE handle = ?").get(
      normalizeHandle(handle),
    ) as { opted_out: number; changed_ms: number } | undefined;
    if (row?.opted_out === 1) {
      return { allowed: false, reason: "opted-out", sinceMs: row.changed_ms };
    }
    return { allowed: true };
  }

  // ── conversation registry ──────────────────────────────────────────────
  /**
   * What a ConversationSid IS — a DM with one person, or a group. Written on
   * first sight (after one participant fetch) so later webhooks classify
   * without an API round-trip. `peerHandle` is set only for DMs.
   */
  registerConversation(sid: string, kind: "dm" | "group", peerHandle?: string | null): void {
    this.db.run(
      `INSERT INTO sms_conversations (conversation_sid, kind, peer_handle, seen_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_sid) DO UPDATE SET kind = ?, peer_handle = ?`,
      [
        sid,
        kind,
        peerHandle ? normalizeHandle(peerHandle) : null,
        Date.now(),
        kind,
        peerHandle ? normalizeHandle(peerHandle) : null,
      ],
    );
  }

  conversationKind(sid: string): { kind: "dm" | "group"; peerHandle: string | null } | null {
    const row = this.q(
      "SELECT kind, peer_handle FROM sms_conversations WHERE conversation_sid = ?",
    ).get(sid) as { kind: "dm" | "group"; peer_handle: string | null } | undefined;
    return row ? { kind: row.kind, peerHandle: row.peer_handle } : null;
  }

  /** The Conversation that fronts a DM with this handle, if one is known. */
  conversationForDm(handle: string): string | null {
    const row = this.q(
      "SELECT conversation_sid FROM sms_conversations WHERE kind = 'dm' AND peer_handle = ?",
    ).get(normalizeHandle(handle)) as { conversation_sid: string } | undefined;
    return row?.conversation_sid ?? null;
  }

  // ── groups ─────────────────────────────────────────────────────────────
  /** Replace a group's membership snapshot with webhook truth. */
  upsertGroup(info: GroupInfo, atMs = Date.now()): void {
    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO sms_groups (conversation_sid, friendly_name, updated_ms) VALUES (?, ?, ?)
         ON CONFLICT(conversation_sid) DO UPDATE SET friendly_name = ?, updated_ms = ?`,
        [info.conversationSid, info.friendlyName, atMs, info.friendlyName, atMs],
      );
      this.db.run("DELETE FROM sms_group_members WHERE conversation_sid = ?", [
        info.conversationSid,
      ]);
      for (const h of info.participants) {
        this.db.run(
          "INSERT OR IGNORE INTO sms_group_members (conversation_sid, handle) VALUES (?, ?)",
          [info.conversationSid, normalizeHandle(h)],
        );
      }
    });
    tx();
  }

  groupInfo(conversationSid: string): GroupInfo | null {
    const g = this.q(
      "SELECT conversation_sid, friendly_name FROM sms_groups WHERE conversation_sid = ?",
    ).get(conversationSid) as
      | { conversation_sid: string; friendly_name: string | null }
      | undefined;
    if (!g) return null;
    const members = this.q(
      "SELECT handle FROM sms_group_members WHERE conversation_sid = ? ORDER BY handle",
    ).all(conversationSid) as { handle: string }[];
    return {
      conversationSid: g.conversation_sid,
      friendlyName: g.friendly_name,
      participants: members.map((m) => m.handle),
    };
  }

  // ── transcript ─────────────────────────────────────────────────────────
  record(params: {
    conversation: string;
    direction: SmsDirection;
    body: string;
    /** Sender handle for inbound; ignored (stored '') for outbound. */
    fromHandle?: string;
    messageSid?: string | null;
    atMs?: number;
  }): void {
    this.db.run(
      `INSERT OR IGNORE INTO sms_messages
         (conversation, from_handle, direction, body, message_sid, at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        params.conversation,
        params.direction === "in" ? normalizeHandle(params.fromHandle ?? "") : "",
        params.direction,
        params.body,
        params.messageSid ?? null,
        params.atMs ?? Date.now(),
      ],
    );
  }

  /**
   * Recent messages in a conversation, oldest → newest, in the shape the
   * envelope's history formatter already understands. `rowId` is this
   * store's autoincrement id; it is never joined against chat.db — the two
   * id spaces stay separate — but `HistoryLine` requires the field and
   * segmentation compares it only within one list.
   */
  recentLines(conversation: string, limit: number): HistoryLine[] {
    const rows = this.q(
      `SELECT id, from_handle, direction, body, at_ms FROM sms_messages
       WHERE conversation = ? ORDER BY at_ms DESC, id DESC LIMIT ?`,
    ).all(conversation, Math.max(0, limit)) as {
      id: number;
      from_handle: string;
      direction: SmsDirection;
      body: string;
      at_ms: number;
    }[];
    return rows.reverse().map((r) => ({
      rowId: r.id,
      timestampMs: r.at_ms,
      fromHandle: r.from_handle,
      fromMe: r.direction === "out",
      text: r.body,
      isTapback: false,
      tapbackTargetIsMe: false,
      tapbackTargetHandle: "",
    }));
  }

  /** Unix ms of the last message either way, or null if never. */
  lastMessageMs(conversation: string): number | null {
    const row = this.q("SELECT MAX(at_ms) AS m FROM sms_messages WHERE conversation = ?").get(
      conversation,
    ) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  // ── cost ledger ────────────────────────────────────────────────────────
  recordSpend(r: {
    messageSid: string;
    direction: SmsDirection;
    counterparty: string;
    segments: number;
    estUsd: number;
    atMs?: number;
  }): void {
    this.db.run(
      `INSERT OR IGNORE INTO sms_spend
         (message_sid, direction, counterparty, segments, est_usd, at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        r.messageSid,
        r.direction,
        normalizeHandle(r.counterparty),
        r.segments,
        r.estUsd,
        r.atMs ?? Date.now(),
      ],
    );
  }

  spendRow(messageSid: string): { estUsd: number; actualUsd: number | null } | null {
    const row = this.q("SELECT est_usd, actual_usd FROM sms_spend WHERE message_sid = ?").get(
      messageSid,
    ) as { est_usd: number; actual_usd: number | null } | undefined;
    return row ? { estUsd: row.est_usd, actualUsd: row.actual_usd } : null;
  }

  reconcileSpend(messageSid: string, actualUsd: number, nowMs = Date.now()): void {
    this.db.run("UPDATE sms_spend SET actual_usd = ?, reconciled_ms = ? WHERE message_sid = ?", [
      actualUsd,
      nowMs,
      messageSid,
    ]);
  }

  /** Totals since `sinceMs`, split by direction, with estimate fallback for
   *  rows whose actual price has not posted yet. */
  spendSummary(sinceMs: number): {
    inCount: number;
    outCount: number;
    totalUsd: number;
    unreconciled: number;
  } {
    const row = this.q(
      `SELECT
         SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END)  AS in_count,
         SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS out_count,
         SUM(COALESCE(actual_usd, est_usd))                 AS total_usd,
         SUM(CASE WHEN actual_usd IS NULL THEN 1 ELSE 0 END) AS unreconciled
       FROM sms_spend WHERE at_ms >= ?`,
    ).get(sinceMs) as {
      in_count: number | null;
      out_count: number | null;
      total_usd: number | null;
      unreconciled: number | null;
    };
    return {
      inCount: row.in_count ?? 0,
      outCount: row.out_count ?? 0,
      totalUsd: row.total_usd ?? 0,
      unreconciled: row.unreconciled ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }
}
