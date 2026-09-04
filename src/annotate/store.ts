import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";

/**
 * Persistent record of an outstanding image-annotation link.
 *
 * Security model:
 *   - URL is /a/<id>/<key>. `id` is a short public identifier; `key` is the
 *     secret. Both are cryptographically random.
 *   - The database stores only sha256(key), not the key itself. An attacker
 *     who reads annotations.db cannot reconstruct a working URL.
 *   - Key verification is constant-time (crypto.timingSafeEqual).
 *   - Links are single-use (`used` flag) and expire on a TTL.
 *
 * Shared between daemon and dashboard — both open the DB in WAL mode, same
 * pattern as cron.db.
 */
export type AnnotationRecord = {
  id: string;
  sessionKey: string;
  /** Handle who will "send" the synthetic re-invocation (for sender label). Null for session with no known handle. */
  senderHandle: string | null;
  /** Absolute path of the source image shown to the user for annotation. */
  imagePath: string;
  /** Optional hint displayed above the image (the instruction the model passed in). */
  instruction: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  /** 0 = link is still live, 1 = already submitted. Single-use. */
  used: number;
  /**
   * PID of the cloudflared wrapper script that owns the public tunnel for
   * this link, when one was successfully started. Null = no tunnel (link
   * falls back to LAN URL). The dashboard's submit handler SIGTERMs this
   * PID after a successful submit so the public URL drops immediately
   * instead of lingering until the TTL elapses.
   */
  tunnelPid: number | null;
};

/** Public record returned on create(). Includes the plaintext key, which the tool surfaces exactly once. */
export type CreatedAnnotation = AnnotationRecord & { key: string };

/** Entropy (bytes → hex chars). 16 bytes = 32 hex chars, 128 bits. */
const ID_BYTES = 8; // 64 bits — collision space is the wall; verified against hashed key anyway
const KEY_BYTES = 24; // 192 bits — this is the actual secret

export class AnnotationStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "annotations.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS annotations (
        id            TEXT PRIMARY KEY,
        key_hash      TEXT NOT NULL,
        session_key   TEXT NOT NULL,
        sender_handle TEXT,
        image_path    TEXT NOT NULL,
        instruction   TEXT,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        used          INTEGER NOT NULL DEFAULT 0,
        tunnel_pid    INTEGER
      );
      CREATE INDEX IF NOT EXISTS annotations_expires_idx ON annotations(expires_at_ms);
    `);
    // Migration for dbs that predate tunnel_pid. Ignore "duplicate column"
    // errors so this is idempotent on restart.
    try {
      this.db.exec("ALTER TABLE annotations ADD COLUMN tunnel_pid INTEGER");
    } catch {
      // column already exists
    }
  }

  create(input: {
    sessionKey: string;
    senderHandle: string | null;
    imagePath: string;
    instruction: string | null;
    ttlMs: number;
  }): CreatedAnnotation {
    const id = randomBytes(ID_BYTES).toString("hex");
    const key = randomBytes(KEY_BYTES).toString("hex");
    const keyHash = hashKey(key);
    const now = Date.now();
    const record: AnnotationRecord = {
      id,
      sessionKey: input.sessionKey,
      senderHandle: input.senderHandle,
      imagePath: input.imagePath,
      instruction: input.instruction,
      createdAtMs: now,
      expiresAtMs: now + input.ttlMs,
      used: 0,
      tunnelPid: null,
    };
    this.db
      .query(
        "INSERT INTO annotations(id, key_hash, session_key, sender_handle, image_path, instruction, created_at_ms, expires_at_ms, used, tunnel_pid) VALUES (?,?,?,?,?,?,?,?,0,NULL)",
      )
      .run(
        record.id,
        keyHash,
        record.sessionKey,
        record.senderHandle,
        record.imagePath,
        record.instruction,
        record.createdAtMs,
        record.expiresAtMs,
      );
    return { ...record, key };
  }

  /** Record the cloudflared wrapper PID so the submit handler can end the tunnel early. */
  setTunnelPid(id: string, tunnelPid: number): void {
    this.db.query("UPDATE annotations SET tunnel_pid = ? WHERE id = ?").run(tunnelPid, id);
  }

  /**
   * Verify a presented id+key and return the record if all checks pass:
   *   - id exists
   *   - sha256(key) matches stored hash (constant-time compare)
   *   - not yet used
   *   - not yet expired
   *
   * Returns null for every failure mode so callers can't distinguish them
   * (and must not branch on the reason externally — they should emit the
   * same response either way, to avoid side-channel enumeration).
   */
  verify(id: string, key: string): AnnotationRecord | null {
    if (!id || !key) return null;
    const row = this.db.query("SELECT * FROM annotations WHERE id = ?").get(id) as
      | RawRow
      | undefined;
    if (!row) return null;
    if (!constantTimeHexEqual(hashKey(key), row.key_hash)) return null;
    if (row.used) return null;
    if (row.expires_at_ms < Date.now()) return null;
    return rowToRecord(row);
  }

  markUsed(id: string): void {
    this.db.query("UPDATE annotations SET used = 1 WHERE id = ?").run(id);
  }

  /** Lookup without key check — for dashboard listings only. */
  getById(id: string): AnnotationRecord | null {
    const row = this.db.query("SELECT * FROM annotations WHERE id = ?").get(id) as
      | RawRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Recent links across all sessions (or a single session) for the dashboard. */
  listRecent(opts: { sessionKey?: string; limit?: number } = {}): AnnotationRecord[] {
    const limit = Math.min(500, opts.limit ?? 100);
    const rows = opts.sessionKey
      ? (this.db
          .query(
            "SELECT * FROM annotations WHERE session_key = ? ORDER BY created_at_ms DESC LIMIT ?",
          )
          .all(opts.sessionKey, limit) as RawRow[])
      : (this.db
          .query("SELECT * FROM annotations ORDER BY created_at_ms DESC LIMIT ?")
          .all(limit) as RawRow[]);
    return rows.map(rowToRecord);
  }

  /** Force-expire a link so the URL stops working. Returns true if updated. */
  revoke(id: string): boolean {
    const res = this.db
      .query("UPDATE annotations SET expires_at_ms = ?, used = 1 WHERE id = ?")
      .run(Date.now(), id);
    return Number(res.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type RawRow = {
  id: string;
  key_hash: string;
  session_key: string;
  sender_handle: string | null;
  image_path: string;
  instruction: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  used: number;
  tunnel_pid: number | null;
};

function rowToRecord(r: RawRow): AnnotationRecord {
  return {
    id: r.id,
    sessionKey: r.session_key,
    senderHandle: r.sender_handle,
    imagePath: r.image_path,
    instruction: r.instruction,
    createdAtMs: r.created_at_ms,
    expiresAtMs: r.expires_at_ms,
    used: r.used,
    tunnelPid: r.tunnel_pid,
  };
}
