/**
 * The feature log — announcements about new capabilities, and the record of
 * who has actually heard about each one.
 *
 * Two tables because they answer two different questions and change at wildly
 * different rates: `announcements` is written by hand a few times a month,
 * `deliveries` is written whenever a turn considers surfacing one.
 *
 * The delivery row is per (announcement, session) and it is the thing that
 * makes this safe to run unattended. Every rule the operator cares about —
 * tell each person once, don't nag, don't pitch someone who barely texts — is
 * enforced against a row here rather than against a model's memory of what it
 * has already said.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionKey } from "../sessions/key.ts";

export type Announcement = {
  id: string;
  /** Short label for the operator's own list. Never shown to a user. */
  title: string;
  /** What Edmund should convey, in his own words. Shown to the model. */
  body: string;
  /**
   * Portal-relative path this points at, e.g. "/skills". Rendered against the
   * recipient's own standing portal link, so every person gets a URL that
   * works for them and nobody gets a shared secret.
   *
   * Kept non-null in practice: a link is how delivery is CONFIRMED. Without
   * one there is no mechanical way to tell whether the model actually
   * mentioned the thing, and an unverifiable delivery gets marked spent on
   * the first offer instead.
   */
  link_path: string | null;
  created_ms: number;
  /** Nothing is offered before this. Lets one be written ahead of a launch. */
  starts_ms: number;
  /** After this it is inert. Null = no expiry. */
  expires_ms: number | null;
  /** Operator override of the global engagement floor, for one announcement. */
  min_active_days: number | null;
  active: boolean;
};

export type DeliveryState = "offered" | "delivered" | "exhausted";

export type Delivery = {
  announcement_id: string;
  session_key: SessionKey;
  state: DeliveryState;
  offers: number;
  first_offered_ms: number;
  last_offered_ms: number;
  delivered_ms: number | null;
};

export class AnnouncementStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "announcements.db"));
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS announcements (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        body            TEXT NOT NULL,
        link_path       TEXT,
        created_ms      INTEGER NOT NULL,
        starts_ms       INTEGER NOT NULL,
        expires_ms      INTEGER,
        min_active_days INTEGER,
        active          INTEGER NOT NULL DEFAULT 1
      );
      -- One row per (announcement, conversation). The PRIMARY KEY is the
      -- whole point: it is what makes "tell each person once" a property of
      -- the schema rather than a thing the caller has to remember.
      CREATE TABLE IF NOT EXISTS deliveries (
        announcement_id  TEXT NOT NULL,
        session_key      TEXT NOT NULL,
        state            TEXT NOT NULL,
        offers           INTEGER NOT NULL DEFAULT 0,
        first_offered_ms INTEGER NOT NULL,
        last_offered_ms  INTEGER NOT NULL,
        delivered_ms     INTEGER,
        PRIMARY KEY (announcement_id, session_key)
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_session ON deliveries(session_key, last_offered_ms DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  add(a: Omit<Announcement, "created_ms"> & { created_ms?: number }): Announcement {
    const row: Announcement = { ...a, created_ms: a.created_ms ?? Date.now() };
    this.db
      .query(
        `INSERT INTO announcements (id, title, body, link_path, created_ms, starts_ms, expires_ms, min_active_days, active)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.title,
        row.body,
        row.link_path,
        row.created_ms,
        row.starts_ms,
        row.expires_ms,
        row.min_active_days,
        row.active ? 1 : 0,
      );
    return row;
  }

  list(): Announcement[] {
    return this.db
      .query<RawAnnouncement, []>("SELECT * FROM announcements ORDER BY created_ms DESC")
      .all()
      .map(hydrate);
  }

  get(id: string): Announcement | null {
    const row = this.db
      .query<RawAnnouncement, [string]>("SELECT * FROM announcements WHERE id = ?")
      .get(id);
    return row ? hydrate(row) : null;
  }

  setActive(id: string, active: boolean): boolean {
    const r = this.db
      .query("UPDATE announcements SET active = ? WHERE id = ?")
      .run(active ? 1 : 0, id);
    return r.changes > 0;
  }

  /**
   * Announcements that are live right now, oldest first.
   *
   * Oldest first on purpose: a person who has missed two should hear about
   * the older one before the newer, or the backlog never drains and the
   * oldest entry is silently never told to anyone.
   */
  liveAnnouncements(now = Date.now()): Announcement[] {
    return this.db
      .query<RawAnnouncement, [number, number]>(
        `SELECT * FROM announcements
          WHERE active = 1 AND starts_ms <= ?
            AND (expires_ms IS NULL OR expires_ms > ?)
          ORDER BY created_ms ASC`,
      )
      .all(now, now)
      .map(hydrate);
  }

  delivery(announcementId: string, sessionKey: SessionKey): Delivery | null {
    const row = this.db
      .query<RawDelivery, [string, string]>(
        "SELECT * FROM deliveries WHERE announcement_id = ? AND session_key = ?",
      )
      .get(announcementId, sessionKey);
    return row ? hydrateDelivery(row) : null;
  }

  deliveriesFor(sessionKey: SessionKey): Delivery[] {
    return this.db
      .query<RawDelivery, [string]>("SELECT * FROM deliveries WHERE session_key = ?")
      .all(sessionKey)
      .map(hydrateDelivery);
  }

  deliveriesOf(announcementId: string): Delivery[] {
    return this.db
      .query<RawDelivery, [string]>("SELECT * FROM deliveries WHERE announcement_id = ?")
      .all(announcementId)
      .map(hydrateDelivery);
  }

  /**
   * The most recent time a DIFFERENT announcement was offered here.
   *
   * `exclude` is the announcement currently being considered, and leaving it
   * out is what keeps two separate limits from collapsing into one. The
   * global cooldown governs how often a person hears about a NEW thing; the
   * re-offer cooldown and `max_offers` govern how many chances the model gets
   * at the SAME thing. Counting the current announcement against the global
   * cooldown made `max_offers` unreachable — a second chance could never
   * arrive before the 14-day gate opened, by which point the announcement had
   * been waiting a fortnight for a natural opening.
   *
   * It counts offers, not deliveries: an offer the model declined still
   * consumed the chance.
   */
  lastOfferMs(sessionKey: SessionKey, exclude?: string): number {
    const row = exclude
      ? this.db
          .query<{ m: number | null }, [string, string]>(
            "SELECT MAX(last_offered_ms) AS m FROM deliveries WHERE session_key = ? AND announcement_id != ?",
          )
          .get(sessionKey, exclude)
      : this.db
          .query<{ m: number | null }, [string]>(
            "SELECT MAX(last_offered_ms) AS m FROM deliveries WHERE session_key = ?",
          )
          .get(sessionKey);
    return row?.m ?? 0;
  }

  /** Record that an announcement was put in front of a conversation. */
  recordOffer(announcementId: string, sessionKey: SessionKey, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO deliveries (announcement_id, session_key, state, offers, first_offered_ms, last_offered_ms)
         VALUES (?, ?, 'offered', 1, ?, ?)
         ON CONFLICT(announcement_id, session_key) DO UPDATE SET
           offers = offers + 1,
           last_offered_ms = excluded.last_offered_ms`,
      )
      .run(announcementId, sessionKey, now, now);
  }

  /** Record that the reply actually carried it. Terminal — never re-offered. */
  markDelivered(announcementId: string, sessionKey: SessionKey, now = Date.now()): void {
    this.db
      .query(
        `UPDATE deliveries SET state = 'delivered', delivered_ms = ?
          WHERE announcement_id = ? AND session_key = ?`,
      )
      .run(now, announcementId, sessionKey);
  }

  /**
   * Give up on this pairing. Also terminal.
   *
   * Reached when the model has been offered an opening several times and
   * never taken it. That is information, not a failure to retry harder: for
   * this person, in this conversation, there was never a natural moment.
   */
  markExhausted(announcementId: string, sessionKey: SessionKey): void {
    this.db
      .query(
        "UPDATE deliveries SET state = 'exhausted' WHERE announcement_id = ? AND session_key = ?",
      )
      .run(announcementId, sessionKey);
  }
}

type RawAnnouncement = {
  id: string;
  title: string;
  body: string;
  link_path: string | null;
  created_ms: number;
  starts_ms: number;
  expires_ms: number | null;
  min_active_days: number | null;
  active: number;
};

type RawDelivery = {
  announcement_id: string;
  session_key: string;
  state: string;
  offers: number;
  first_offered_ms: number;
  last_offered_ms: number;
  delivered_ms: number | null;
};

function hydrate(r: RawAnnouncement): Announcement {
  return { ...r, active: r.active === 1 };
}

function hydrateDelivery(r: RawDelivery): Delivery {
  return { ...r, state: r.state as DeliveryState };
}
