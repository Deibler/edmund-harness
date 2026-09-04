import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../../src/db/open.ts";
import {
  type AgentFrame,
  AgentFrameSchema,
  type MirrorComponentSpec,
  type MirrorContent,
  MirrorContentSchema,
  type MirrorLifespan,
  type MirrorPresentation,
  type MirrorZone,
  mirrorFrameId,
} from "./protocol.ts";

/**
 * Durable source of truth for the glass.
 *
 * State mutations and their protocol outbox record commit in one SQLite
 * transaction. The daemon retires an outbox row only after the Pi explicitly
 * acknowledges its message id. Reconnects begin with a full revisioned
 * snapshot, so old queued deltas become harmless duplicates.
 */

const MAX_OUTBOX_ROWS = 2_000;
const MAX_AUDIT_ROWS = 5_000;

export type MirrorContentInput = MirrorComponentSpec & {
  id: string;
  page?: string;
  zone: MirrorZone;
  presentation?: MirrorPresentation;
  lifespan: MirrorLifespan;
  priority?: number;
  expiresAtMs?: number | null;
  protected?: boolean;
};

export type MirrorOutboxRow = {
  messageId: string;
  payload: string;
  revision: number | null;
  createdAtMs: number;
  expiresAtMs: number | null;
  attemptCount: number;
  lastAttemptMs: number | null;
};

export type MirrorSnapshot = {
  revision: number;
  page: string;
  rotation: 0 | 90 | 180 | 270;
  contents: MirrorContent[];
};

export type MirrorAuditRow = {
  id: number;
  revision: number;
  action: string;
  targetId: string | null;
  reason: string | null;
  createdAtMs: number;
};

type ContentRow = {
  id: string;
  page: string;
  zone: string;
  presentation: string;
  component: string;
  props_json: string;
  lifespan: string;
  priority: number;
  expires_at_ms: number | null;
  protected: number;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export class MirrorStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "mirror.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mirror_meta_v2 (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mirror_content_v2 (
        id TEXT PRIMARY KEY,
        page TEXT NOT NULL,
        zone TEXT NOT NULL,
        presentation TEXT NOT NULL,
        component TEXT NOT NULL,
        props_json TEXT NOT NULL,
        lifespan TEXT NOT NULL,
        priority INTEGER NOT NULL,
        expires_at_ms INTEGER,
        protected INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mirror_content_v2_page_zone
        ON mirror_content_v2(page, zone, priority DESC, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS mirror_content_v2_expiry
        ON mirror_content_v2(expires_at_ms) WHERE expires_at_ms IS NOT NULL;

      CREATE TABLE IF NOT EXISTS mirror_widget_state_v2 (
        widget_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        value_type TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(widget_id, key)
      );

      CREATE TABLE IF NOT EXISTS mirror_outbox_v2 (
        message_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        revision INTEGER,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS mirror_outbox_v2_ready
        ON mirror_outbox_v2(last_attempt_ms, created_at_ms);

      CREATE TABLE IF NOT EXISTS mirror_audit_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision INTEGER NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT,
        before_json TEXT,
        after_json TEXT,
        reason TEXT,
        created_at_ms INTEGER NOT NULL
      );
    `);
    const outboxColumns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(mirror_outbox_v2)")
      .all();
    if (!outboxColumns.some((column) => column.name === "expires_at_ms")) {
      this.db.exec("ALTER TABLE mirror_outbox_v2 ADD COLUMN expires_at_ms INTEGER");
    }
    this.db
      .query("INSERT OR IGNORE INTO mirror_meta_v2 (key, value) VALUES ('revision', '0')")
      .run();
    this.db
      .query("INSERT OR IGNORE INTO mirror_meta_v2 (key, value) VALUES ('page', 'home')")
      .run();
    this.db
      .query("INSERT OR IGNORE INTO mirror_meta_v2 (key, value) VALUES ('rotation', '0')")
      .run();
    this.seedBaseline();
  }

  get revision(): number {
    return Number(this.getMeta("revision", "0")) || 0;
  }

  snapshot(): MirrorSnapshot {
    const rotation = Number(this.getMeta("rotation", "0"));
    return {
      revision: this.revision,
      page: this.getMeta("page", "home"),
      rotation: rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0,
      contents: this.listContent(),
    };
  }

  listContent(options: { includeExpired?: boolean; nowMs?: number } = {}): MirrorContent[] {
    const now = options.nowMs ?? Date.now();
    const rows = options.includeExpired
      ? this.db
          .query<ContentRow, []>(
            `SELECT * FROM mirror_content_v2
             ORDER BY page, zone, priority DESC, updated_at_ms DESC, id`,
          )
          .all()
      : this.db
          .query<ContentRow, [number]>(
            `SELECT * FROM mirror_content_v2
             WHERE expires_at_ms IS NULL OR expires_at_ms > ?
             ORDER BY page, zone, priority DESC, updated_at_ms DESC, id`,
          )
          .all(now);
    return rows.map(rowToContent).filter((item): item is MirrorContent => item !== null);
  }

  getContent(id: string): MirrorContent | null {
    const row = this.db
      .query<ContentRow, [string]>("SELECT * FROM mirror_content_v2 WHERE id = ?")
      .get(id);
    return row ? rowToContent(row) : null;
  }

  upsertContent(input: MirrorContentInput, reason = "tool"): MirrorContent {
    let result: MirrorContent | null = null;
    this.transaction(() => {
      const existing = this.getContent(input.id);
      if (existing?.protected && input.protected !== true) {
        throw new Error(`content '${input.id}' is a protected baseline fixture`);
      }
      const now = Date.now();
      const revision = this.bumpRevision();
      const candidate = MirrorContentSchema.parse({
        ...input,
        page: input.page ?? existing?.page ?? "home",
        presentation: input.presentation ?? existing?.presentation ?? "widget",
        priority: input.priority ?? existing?.priority ?? 0,
        expiresAtMs:
          input.expiresAtMs !== undefined ? input.expiresAtMs : (existing?.expiresAtMs ?? null),
        protected: input.protected ?? existing?.protected ?? false,
        revision,
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now,
      });
      this.writeContent(candidate);
      this.enqueueFrame({
        v: 2,
        id: mirrorFrameId("content"),
        type: "content_upsert",
        revision,
        content: candidate,
      });
      this.audit(
        revision,
        existing ? "content.update" : "content.create",
        candidate.id,
        existing,
        candidate,
        reason,
      );
      result = candidate;
    });
    return result!;
  }

  removeContent(id: string, reason = "tool"): boolean {
    let removed = false;
    this.transaction(() => {
      const existing = this.getContent(id);
      if (!existing) return;
      if (existing.protected) throw new Error(`content '${id}' is a protected baseline fixture`);
      const revision = this.bumpRevision();
      this.db.query("DELETE FROM mirror_content_v2 WHERE id = ?").run(id);
      this.enqueueFrame({
        v: 2,
        id: mirrorFrameId("content"),
        type: "content_remove",
        revision,
        contentId: id,
      });
      this.audit(revision, "content.remove", id, existing, null, reason);
      removed = true;
    });
    return removed;
  }

  setPage(page: string, reason = "tool"): number {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(page)) {
      throw new Error("page must be 1-40 letters, digits, underscores, or hyphens");
    }
    let revision = this.revision;
    this.transaction(() => {
      const before = this.getMeta("page", "home");
      if (before === page) return;
      revision = this.bumpRevision();
      this.setMeta("page", page);
      this.enqueueFrame({
        v: 2,
        id: mirrorFrameId("page"),
        type: "page_set",
        revision,
        page,
      });
      this.audit(revision, "page.set", page, before, page, reason);
    });
    return revision;
  }

  setRotation(rotation: 0 | 90 | 180 | 270, reason = "tool"): number {
    if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
      throw new Error("rotation must be 0, 90, 180, or 270 degrees");
    }
    let revision = this.revision;
    this.transaction(() => {
      const before = this.snapshot().rotation;
      if (before === rotation) return;
      revision = this.bumpRevision();
      this.setMeta("rotation", String(rotation));
      this.enqueueFrame(this.snapshotFrame(revision));
      this.audit(revision, "rotation.set", null, before, rotation, reason);
    });
    return revision;
  }

  resetToBaseline(reason = "tool"): { removed: string[]; revision: number } {
    const removed: string[] = [];
    let revision = this.revision;
    this.transaction(() => {
      const custom = this.listContent({ includeExpired: true }).filter((item) => !item.protected);
      const page = this.getMeta("page", "home");
      if (custom.length === 0 && page === "home") return;
      revision = this.bumpRevision();
      for (const item of custom) removed.push(item.id);
      this.db.query("DELETE FROM mirror_content_v2 WHERE protected = 0").run();
      this.setMeta("page", "home");
      this.enqueueFrame(this.snapshotFrame(revision));
      this.audit(revision, "layout.reset", null, custom, this.listContent(), reason);
    });
    return { removed, revision };
  }

  pruneExpired(nowMs = Date.now()): string[] {
    const expired = this.listContent({ includeExpired: true }).filter(
      (item) => !item.protected && item.expiresAtMs != null && item.expiresAtMs <= nowMs,
    );
    if (expired.length === 0) return [];
    this.transaction(() => {
      for (const item of expired) {
        const revision = this.bumpRevision();
        this.db.query("DELETE FROM mirror_content_v2 WHERE id = ?").run(item.id);
        this.enqueueFrame({
          v: 2,
          id: mirrorFrameId("expiry"),
          type: "content_remove",
          revision,
          contentId: item.id,
        });
        this.audit(revision, "content.expire", item.id, item, null, "ttl");
      }
    });
    return expired.map((item) => item.id);
  }

  getWidgetState(widgetId: string, key: string): unknown {
    const row = this.db
      .query<{ value_json: string }, [string, string]>(
        "SELECT value_json FROM mirror_widget_state_v2 WHERE widget_id = ? AND key = ?",
      )
      .get(widgetId, key);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return undefined;
    }
  }

  setWidgetState(widgetId: string, key: string, value: unknown, valueType = "json"): void {
    validateStateKey(widgetId, "widget id");
    validateStateKey(key, "state key");
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 16_000) {
      throw new Error("widget state must be JSON-serializable and no larger than 16 KB");
    }
    this.db
      .query(
        `INSERT INTO mirror_widget_state_v2
           (widget_id, key, value_json, value_type, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(widget_id, key) DO UPDATE SET
           value_json = excluded.value_json,
           value_type = excluded.value_type,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(widgetId, key, encoded, valueType.slice(0, 40), Date.now());
  }

  enqueueCommand(frame: AgentFrame, ttlMs = 30_000): void {
    const parsed = AgentFrameSchema.parse(frame);
    const revision = "revision" in parsed ? parsed.revision : null;
    const boundedTtl = Math.max(1_000, Math.min(5 * 60_000, ttlMs));
    this.transaction(() =>
      this.enqueueRaw(parsed.id, JSON.stringify(parsed), revision, Date.now() + boundedTtl),
    );
  }

  enqueueLocalSpeak(text: string): string {
    if (!text.trim() || text.length > 4_000) {
      throw new Error("local mirror speech must be 1-4000 characters");
    }
    const id = mirrorFrameId("speak");
    this.transaction(() =>
      this.enqueueRaw(
        id,
        JSON.stringify({ type: "local_speak", id, text }),
        null,
        Date.now() + 2 * 60_000,
      ),
    );
    return id;
  }

  enqueueLocalClose(): string {
    const id = mirrorFrameId("close");
    this.transaction(() =>
      this.enqueueRaw(
        id,
        JSON.stringify({ type: "local_close", id }),
        null,
        Date.now() + 2 * 60_000,
      ),
    );
    return id;
  }

  listReadyOutbox(nowMs = Date.now(), retryAfterMs = 2_000, limit = 32): MirrorOutboxRow[] {
    this.db
      .query("DELETE FROM mirror_outbox_v2 WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?")
      .run(nowMs);
    return this.db
      .query<
        {
          message_id: string;
          payload: string;
          revision: number | null;
          created_at_ms: number;
          expires_at_ms: number | null;
          attempt_count: number;
          last_attempt_ms: number | null;
        },
        [number, number]
      >(
        `SELECT message_id, payload, revision, created_at_ms, expires_at_ms,
                attempt_count, last_attempt_ms
         FROM mirror_outbox_v2
         WHERE last_attempt_ms IS NULL OR last_attempt_ms <= ?
         ORDER BY created_at_ms, message_id
         LIMIT ?`,
      )
      .all(nowMs - retryAfterMs, Math.max(1, Math.min(128, limit)))
      .map((row) => ({
        messageId: row.message_id,
        payload: row.payload,
        revision: row.revision,
        createdAtMs: row.created_at_ms,
        expiresAtMs: row.expires_at_ms,
        attemptCount: row.attempt_count,
        lastAttemptMs: row.last_attempt_ms,
      }));
  }

  noteOutboxAttempt(messageId: string, nowMs = Date.now()): void {
    this.db
      .query(
        `UPDATE mirror_outbox_v2
         SET attempt_count = attempt_count + 1, last_attempt_ms = ?
         WHERE message_id = ?`,
      )
      .run(nowMs, messageId);
  }

  acknowledgeOutbox(messageId: string): boolean {
    return (
      this.db.query("DELETE FROM mirror_outbox_v2 WHERE message_id = ?").run(messageId).changes > 0
    );
  }

  listAudit(limit = 50): MirrorAuditRow[] {
    return this.db
      .query<
        {
          id: number;
          revision: number;
          action: string;
          target_id: string | null;
          reason: string | null;
          created_at_ms: number;
        },
        [number]
      >(
        `SELECT id, revision, action, target_id, reason, created_at_ms
         FROM mirror_audit_v2 ORDER BY id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit)))
      .map((row) => ({
        id: row.id,
        revision: row.revision,
        action: row.action,
        targetId: row.target_id,
        reason: row.reason,
        createdAtMs: row.created_at_ms,
      }));
  }

  close(): void {
    this.db.close();
  }

  private seedBaseline(): void {
    const now = Date.now();
    const seeds: MirrorContentInput[] = [
      {
        id: "system:clock",
        page: "*",
        zone: "top_left",
        presentation: "widget",
        component: "clock",
        // showDate puts the date directly under the time as one glanceable
        // unit. It replaces the old `system:date` fixture, which sat in the
        // opposite corner and read as an unrelated second thing.
        props: {
          timezone: "local",
          showSeconds: false,
          twelveHour: true,
          showDate: true,
          numeralStyle: "number",
        },
        lifespan: "persistent",
        priority: 100,
        expiresAtMs: null,
        protected: true,
      },
    ];
    for (const seed of seeds) {
      const exists = this.db
        .query<{ id: string }, [string]>("SELECT id FROM mirror_content_v2 WHERE id = ?")
        .get(seed.id);
      if (exists) continue;
      const candidate = MirrorContentSchema.parse({
        ...seed,
        revision: this.revision,
        createdAtMs: now,
        updatedAtMs: now,
      });
      this.writeContent(candidate);
    }
    this.retireLegacyDateFixture();
  }

  /**
   * Fold the old `system:date` fixture into the clock.
   *
   * Existing databases already hold a protected `system:date` in top_right,
   * and `seedBaseline` only ever inserts what is missing — so without this
   * an upgraded mirror would show the date twice: once under the time and
   * once in the far corner. The date is not lost, it moved.
   *
   * Only the protected fixture is touched. A `date` widget the model placed
   * itself is ordinary content and is left alone.
   */
  private retireLegacyDateFixture(): void {
    const legacy = this.db
      .query<{ id: string }, []>(
        "SELECT id FROM mirror_content_v2 WHERE id = 'system:date' AND protected = 1",
      )
      .get();
    if (!legacy) return;

    this.db.query("DELETE FROM mirror_content_v2 WHERE id = 'system:date'").run();

    const clock = this.getContent("system:clock");
    if (clock && clock.component === "clock" && clock.props.showDate !== true) {
      this.writeContent({
        ...clock,
        props: { ...clock.props, showDate: true },
        updatedAtMs: Date.now(),
      });
    }
  }

  private snapshotFrame(revision = this.revision): AgentFrame {
    const snapshot = this.snapshot();
    return {
      v: 2,
      id: mirrorFrameId("snapshot"),
      type: "snapshot",
      revision,
      page: snapshot.page,
      rotation: snapshot.rotation,
      contents: snapshot.contents.map((content) =>
        content.revision > revision ? { ...content, revision } : content,
      ),
    };
  }

  private writeContent(content: MirrorContent): void {
    this.db
      .query(
        `INSERT INTO mirror_content_v2
           (id, page, zone, presentation, component, props_json, lifespan,
            priority, expires_at_ms, protected, revision, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           page = excluded.page,
           zone = excluded.zone,
           presentation = excluded.presentation,
           component = excluded.component,
           props_json = excluded.props_json,
           lifespan = excluded.lifespan,
           priority = excluded.priority,
           expires_at_ms = excluded.expires_at_ms,
           protected = excluded.protected,
           revision = excluded.revision,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        content.id,
        content.page,
        content.zone,
        content.presentation,
        content.component,
        JSON.stringify(content.props),
        content.lifespan,
        content.priority,
        content.expiresAtMs,
        content.protected ? 1 : 0,
        content.revision,
        content.createdAtMs,
        content.updatedAtMs,
      );
  }

  private getMeta(key: string, fallback: string): string {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM mirror_meta_v2 WHERE key = ?")
      .get(key);
    return row?.value ?? fallback;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO mirror_meta_v2 (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private bumpRevision(): number {
    const revision = this.revision + 1;
    this.setMeta("revision", String(revision));
    return revision;
  }

  private enqueueFrame(frame: AgentFrame): void {
    const parsed = AgentFrameSchema.parse(frame);
    const revision = "revision" in parsed ? parsed.revision : null;
    this.enqueueRaw(parsed.id, JSON.stringify(parsed), revision, null);
  }

  private enqueueRaw(
    messageId: string,
    payload: string,
    revision: number | null,
    expiresAtMs: number | null,
  ): void {
    this.db
      .query("DELETE FROM mirror_outbox_v2 WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?")
      .run(Date.now());
    const count =
      this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM mirror_outbox_v2").get()
        ?.count ?? 0;
    if (count >= MAX_OUTBOX_ROWS) {
      throw new Error(`mirror outbox is full (${MAX_OUTBOX_ROWS}); wait for the Pi to reconnect`);
    }
    this.db
      .query(
        `INSERT OR IGNORE INTO mirror_outbox_v2
           (message_id, payload, revision, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(messageId, payload, revision, Date.now(), expiresAtMs);
  }

  private audit(
    revision: number,
    action: string,
    targetId: string | null,
    before: unknown,
    after: unknown,
    reason: string,
  ): void {
    this.db
      .query(
        `INSERT INTO mirror_audit_v2
           (revision, action, target_id, before_json, after_json, reason, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision,
        action.slice(0, 80),
        targetId,
        boundedJson(before),
        boundedJson(after),
        reason.slice(0, 240),
        Date.now(),
      );
    this.db
      .query(
        `DELETE FROM mirror_audit_v2
         WHERE id NOT IN (SELECT id FROM mirror_audit_v2 ORDER BY id DESC LIMIT ?)`,
      )
      .run(MAX_AUDIT_ROWS);
  }

  private transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }
}

function rowToContent(row: ContentRow): MirrorContent | null {
  try {
    return MirrorContentSchema.parse({
      id: row.id,
      page: row.page,
      zone: row.zone,
      presentation: row.presentation,
      component: row.component,
      props: JSON.parse(row.props_json),
      lifespan: row.lifespan,
      priority: row.priority,
      expiresAtMs: row.expires_at_ms,
      protected: row.protected === 1,
      revision: row.revision,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    });
  } catch {
    return null;
  }
}

function validateStateKey(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,79}$/.test(value)) {
    throw new Error(`${label} must be 1-80 safe identifier characters`);
  }
}

function boundedJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded.length <= 32_000 ? encoded : `${encoded.slice(0, 31_980)}…`;
  } catch {
    return null;
  }
}
