import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";

/**
 * What Edmund built for people, and why: one row per page made for a
 * recurring interest, one row per pass of the ideator (so "why was nothing
 * built" can be read back), and the interest threads the last pass verified
 * (the portal's summary). Lives in data/ideations.db; the pages themselves in
 * data/ideations/<id>/. The kitchen host reads it to serve pages and count
 * opens; the daemon writes everything else.
 */

export type IdeationStatus = "building" | "ready" | "failed";

export type Ideation = {
  /** 32 hex characters. Also the page's public path, so it must be unguessable. */
  id: string;
  sessionKey: string;
  /** The interest in the person's own terms ("the night sky"). */
  thread: string;
  /** `thread` normalised, for "not the same thread twice in 21 days". */
  threadKey: string;
  title: string;
  /** One line: what the page is. */
  pitch: string;
  /** Why it goes past what the text replies already gave them. */
  why: string;
  /** What the builder was asked to make. */
  brief: string;
  /** chat.db rows of their own messages that made the thread recur. */
  evidence: number[];
  /** The distinct days those messages span, oldest first. */
  days: string[];
  status: IdeationStatus;
  agentId: string | null;
  failReason: string | null;
  createdMs: number;
  readyMs: number | null;
  /** The wake that tells Edmund to share it was queued. */
  announcedMs: number | null;
  /** The link was found in an outbound message in chat.db. */
  deliveredMs: number | null;
  firstOpenMs: number | null;
  opens: number;
  /** The page's public link, set when it was published. */
  url: string | null;
};

export type IdeatorRun = {
  sessionKey: string;
  ranMs: number;
  /** "built" | "none" | "skipped" | "gated" | "failed" */
  outcome: string;
  detail: string;
  costUsd: number | null;
};

export type InterestThread = {
  label: string;
  days: string[];
  lastSeenMs: number;
  /** Excluded from building, and why (a sensitive category). */
  excluded: string | null;
};

export function threadKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function newIdeationId(): string {
  return randomBytes(16).toString("hex");
}

export const IDEATION_ID = /^[a-f0-9]{32}$/;

export function ideationsDir(dataDir: string): string {
  return join(dataDir, "ideations");
}

type Row = {
  id: string;
  session_key: string;
  thread: string;
  thread_key: string;
  title: string;
  pitch: string;
  why: string;
  brief: string;
  evidence_json: string;
  days_json: string;
  status: IdeationStatus;
  agent_id: string | null;
  fail_reason: string | null;
  created_ms: number;
  ready_ms: number | null;
  announced_ms: number | null;
  delivered_ms: number | null;
  first_open_ms: number | null;
  opens: number;
  url: string | null;
};

function fromRow(r: Row): Ideation {
  return {
    id: r.id,
    sessionKey: r.session_key,
    thread: r.thread,
    threadKey: r.thread_key,
    title: r.title,
    pitch: r.pitch,
    why: r.why,
    brief: r.brief,
    evidence: JSON.parse(r.evidence_json) as number[],
    days: JSON.parse(r.days_json) as string[],
    status: r.status,
    agentId: r.agent_id,
    failReason: r.fail_reason,
    createdMs: r.created_ms,
    readyMs: r.ready_ms,
    announcedMs: r.announced_ms,
    deliveredMs: r.delivered_ms,
    firstOpenMs: r.first_open_ms,
    opens: r.opens,
    url: r.url,
  };
}

export class IdeationStore {
  readonly db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "ideations.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ideations (
        id            TEXT PRIMARY KEY,
        session_key   TEXT NOT NULL,
        thread        TEXT NOT NULL,
        thread_key    TEXT NOT NULL,
        title         TEXT NOT NULL,
        pitch         TEXT NOT NULL,
        why           TEXT NOT NULL,
        brief         TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        days_json     TEXT NOT NULL,
        status        TEXT NOT NULL,
        agent_id      TEXT,
        fail_reason   TEXT,
        created_ms    INTEGER NOT NULL,
        ready_ms      INTEGER,
        announced_ms  INTEGER,
        delivered_ms  INTEGER,
        first_open_ms INTEGER,
        opens         INTEGER NOT NULL DEFAULT 0,
        url           TEXT
      );
      CREATE INDEX IF NOT EXISTS ideations_session ON ideations(session_key, created_ms);
      CREATE INDEX IF NOT EXISTS ideations_agent ON ideations(agent_id);
      CREATE TABLE IF NOT EXISTS ideator_runs (
        session_key TEXT NOT NULL,
        ran_ms      INTEGER NOT NULL,
        outcome     TEXT NOT NULL,
        detail      TEXT NOT NULL,
        cost_usd    REAL
      );
      CREATE INDEX IF NOT EXISTS ideator_runs_session ON ideator_runs(session_key, ran_ms);
      CREATE TABLE IF NOT EXISTS interest_threads (
        session_key  TEXT NOT NULL,
        thread_key   TEXT NOT NULL,
        label        TEXT NOT NULL,
        days_json    TEXT NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        excluded     TEXT,
        updated_ms   INTEGER NOT NULL,
        PRIMARY KEY (session_key, thread_key)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  create(
    i: Omit<
      Ideation,
      | "status"
      | "agentId"
      | "failReason"
      | "readyMs"
      | "announcedMs"
      | "deliveredMs"
      | "firstOpenMs"
      | "opens"
      | "url"
    >,
  ): Ideation {
    this.db
      .query(
        `INSERT INTO ideations (id, session_key, thread, thread_key, title, pitch, why, brief,
           evidence_json, days_json, status, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'building', ?)`,
      )
      .run(
        i.id,
        i.sessionKey,
        i.thread,
        i.threadKey,
        i.title,
        i.pitch,
        i.why,
        i.brief,
        JSON.stringify(i.evidence),
        JSON.stringify(i.days),
        i.createdMs,
      );
    return this.get(i.id) as Ideation;
  }

  get(id: string): Ideation | null {
    if (!IDEATION_ID.test(id)) return null;
    const r = this.db.query("SELECT * FROM ideations WHERE id = ?").get(id) as Row | null;
    return r ? fromRow(r) : null;
  }

  byAgent(agentId: string): Ideation | null {
    const r = this.db
      .query("SELECT * FROM ideations WHERE agent_id = ?")
      .get(agentId) as Row | null;
    return r ? fromRow(r) : null;
  }

  listForSession(sessionKey: string): Ideation[] {
    return (
      this.db
        .query("SELECT * FROM ideations WHERE session_key = ? ORDER BY created_ms DESC")
        .all(sessionKey) as Row[]
    ).map(fromRow);
  }

  /** Every ideation still building, oldest first (for the restart sweep). */
  listBuilding(): Ideation[] {
    return (
      this.db
        .query("SELECT * FROM ideations WHERE status = 'building' ORDER BY created_ms")
        .all() as Row[]
    ).map(fromRow);
  }

  /** Ready and announced, but not yet seen in chat.db. */
  listUndelivered(): Ideation[] {
    return (
      this.db
        .query(
          `SELECT * FROM ideations WHERE status = 'ready' AND announced_ms IS NOT NULL
             AND delivered_ms IS NULL ORDER BY created_ms`,
        )
        .all() as Row[]
    ).map(fromRow);
  }

  setAgent(id: string, agentId: string): void {
    this.db.query("UPDATE ideations SET agent_id = ? WHERE id = ?").run(agentId, id);
  }

  /** Building → ready. Only the publish step calls this, after the page passed its check. */
  markReady(id: string, nowMs: number, url: string | null): boolean {
    return (
      this.db
        .query(
          "UPDATE ideations SET status = 'ready', ready_ms = ?, url = ?, fail_reason = NULL WHERE id = ? AND status = 'building'",
        )
        .run(nowMs, url, id).changes > 0
    );
  }

  markFailed(id: string, reason: string): boolean {
    return (
      this.db
        .query(
          "UPDATE ideations SET status = 'failed', fail_reason = ? WHERE id = ? AND status = 'building'",
        )
        .run(reason.slice(0, 500), id).changes > 0
    );
  }

  /** True once: the first caller to announce it wins. */
  markAnnounced(id: string, nowMs: number): boolean {
    return (
      this.db
        .query(
          "UPDATE ideations SET announced_ms = ? WHERE id = ? AND status = 'ready' AND announced_ms IS NULL",
        )
        .run(nowMs, id).changes > 0
    );
  }

  markDelivered(id: string, atMs: number): void {
    this.db
      .query("UPDATE ideations SET delivered_ms = ? WHERE id = ? AND delivered_ms IS NULL")
      .run(atMs, id);
  }

  /** Count an open of a ready page. Returns false for anything not ready. */
  recordOpen(id: string, nowMs: number): boolean {
    return (
      this.db
        .query(
          `UPDATE ideations SET opens = opens + 1, first_open_ms = COALESCE(first_open_ms, ?)
             WHERE id = ? AND status = 'ready'`,
        )
        .run(nowMs, id).changes > 0
    );
  }

  /** Builds started for this person since `sinceMs` (any outcome). */
  buildsSince(sessionKey: string, sinceMs: number): number {
    const r = this.db
      .query("SELECT count(*) AS n FROM ideations WHERE session_key = ? AND created_ms >= ?")
      .get(sessionKey, sinceMs) as { n: number };
    return r.n;
  }

  /** The newest ideation for this thread that did not fail, or null. */
  lastForThread(sessionKey: string, key: string): Ideation | null {
    const r = this.db
      .query(
        `SELECT * FROM ideations WHERE session_key = ? AND thread_key = ? AND status != 'failed'
           ORDER BY created_ms DESC LIMIT 1`,
      )
      .get(sessionKey, key) as Row | null;
    return r ? fromRow(r) : null;
  }

  recordRun(run: IdeatorRun): void {
    this.db
      .query(
        "INSERT INTO ideator_runs (session_key, ran_ms, outcome, detail, cost_usd) VALUES (?, ?, ?, ?, ?)",
      )
      .run(run.sessionKey, run.ranMs, run.outcome, run.detail.slice(0, 2000), run.costUsd);
  }

  lastRunMs(sessionKey: string): number | null {
    const r = this.db
      .query("SELECT max(ran_ms) AS t FROM ideator_runs WHERE session_key = ?")
      .get(sessionKey) as { t: number | null };
    return r.t;
  }

  /** Replace this person's verified threads with the latest pass's. */
  saveThreads(sessionKey: string, threads: InterestThread[], nowMs: number): void {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM interest_threads WHERE session_key = ?").run(sessionKey);
      const ins = this.db.query(
        `INSERT OR REPLACE INTO interest_threads
           (session_key, thread_key, label, days_json, last_seen_ms, excluded, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const t of threads) {
        ins.run(
          sessionKey,
          threadKey(t.label),
          t.label,
          JSON.stringify(t.days),
          t.lastSeenMs,
          t.excluded,
          nowMs,
        );
      }
    });
    tx();
  }

  threads(sessionKey: string): InterestThread[] {
    const rows = this.db
      .query(
        `SELECT label, days_json, last_seen_ms, excluded FROM interest_threads
           WHERE session_key = ? ORDER BY last_seen_ms DESC`,
      )
      .all(sessionKey) as Array<{
      label: string;
      days_json: string;
      last_seen_ms: number;
      excluded: string | null;
    }>;
    return rows.map((r) => ({
      label: r.label,
      days: JSON.parse(r.days_json) as string[],
      lastSeenMs: r.last_seen_ms,
      excluded: r.excluded,
    }));
  }
}
