import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { openDb } from "../db/open.ts";
import { genId } from "../util/ids.ts";
import { nextFire } from "./next-fire.ts";
import type { CronJob, JobInput, JobSchedule } from "./types.ts";

/** Runtime shape check for the `schedule_json` blob — guards against a
 * hand-edited DB or a schema drift feeding garbage into the scheduler. */
const JobScheduleSchema: z.ZodType<JobSchedule> = z.union([
  z.object({ kind: z.literal("once"), atMs: z.number() }),
  z.object({ kind: z.literal("cron"), expr: z.string(), tz: z.string().optional() }),
]);

function parseJobSchedule(raw: string): JobSchedule | null {
  try {
    return JobScheduleSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export class CronStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "cron.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        system_event TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        next_fire_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_fired_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        grace_period_ms INTEGER,
        attach_images_json TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_fire_idx ON jobs(status, next_fire_ms);
    `);
    // Migration: add grace_period_ms to existing databases that predate this column.
    try {
      this.db.exec("ALTER TABLE jobs ADD COLUMN grace_period_ms INTEGER");
    } catch {
      // Column already exists — nothing to do.
    }
    // Migration: add attach_images_json for wake-ups that carry images.
    try {
      this.db.exec("ALTER TABLE jobs ADD COLUMN attach_images_json TEXT");
    } catch {
      // Column already exists.
    }
  }

  create(input: JobInput): CronJob {
    const now = Date.now();
    const next = nextFire(input.schedule, now);
    if (!next) throw new Error("schedule would never fire");
    const gracePeriodMs = input.gracePeriodMs ?? null;
    const attachImages =
      input.attachImages && input.attachImages.length > 0 ? input.attachImages : null;
    const job: CronJob = {
      id: genId("job"),
      sessionKey: input.sessionKey,
      systemEvent: input.systemEvent,
      schedule: input.schedule,
      nextFireMs: next,
      createdAt: now,
      lastFiredMs: null,
      status: "active",
      gracePeriodMs,
      attachImages,
    };
    this.db
      .query(
        "INSERT INTO jobs(id, session_key, system_event, schedule_json, next_fire_ms, created_at, last_fired_ms, status, grace_period_ms, attach_images_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        job.id,
        job.sessionKey,
        job.systemEvent,
        JSON.stringify(job.schedule),
        job.nextFireMs,
        job.createdAt,
        null,
        job.status,
        gracePeriodMs,
        attachImages ? JSON.stringify(attachImages) : null,
      );
    return job;
  }

  /** Mark a row as canceled so an unreadable/corrupt job stops being
   * returned by `nextDue`/`listActive`. */
  private quarantine(id: string): void {
    try {
      this.db.query("UPDATE jobs SET status='canceled' WHERE id = ?").run(id);
    } catch (err) {
      console.error(`[cron] failed to quarantine job ${id}:`, err);
    }
  }

  /** Hydrate a row; if it's unreadable, quarantine it in the DB and return null. */
  private hydrate(row: RawRow): CronJob | null {
    const job = rowToJob(row);
    if (!job) this.quarantine(row.id);
    return job;
  }

  get(id: string): CronJob | null {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as RawRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  /** Pause an active job — the scheduler only picks status='active', so a
   *  paused job simply never fires until resumed. Used by the user portal. */
  pause(id: string): boolean {
    const res = this.db
      .query("UPDATE jobs SET status='paused' WHERE id = ? AND status='active'")
      .run(id);
    return res.changes > 0;
  }

  /** Resume a paused job. Next fire is recomputed from the schedule; a
   *  once-job whose moment passed while paused fires shortly after resume
   *  (late beats lost). */
  resume(id: string): boolean {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ? AND status='paused'").get(id) as
      | RawRow
      | undefined;
    if (!row) return false;
    const job = rowToJob(row);
    if (!job) return false;
    const next =
      job.schedule.kind === "once"
        ? Math.max(job.schedule.atMs, Date.now() + 30_000)
        : (nextFire(job.schedule, Date.now()) ?? Date.now() + 60_000);
    const res = this.db
      .query("UPDATE jobs SET status='active', next_fire_ms=? WHERE id = ? AND status='paused'")
      .run(next, id);
    return res.changes > 0;
  }

  /** A session's jobs in active OR paused state — the user-portal view. */
  listForPortal(sessionKey: string): CronJob[] {
    const rows = this.db
      .query(
        "SELECT * FROM jobs WHERE status IN ('active','paused') AND session_key = ? ORDER BY next_fire_ms ASC",
      )
      .all(sessionKey) as RawRow[];
    return rows.map((r) => this.hydrate(r)).filter((j): j is CronJob => j !== null);
  }

  /**
   * Update an active job's schedule and/or event text.
   * Returns the updated job, or null if the job doesn't exist or isn't active.
   */
  update(
    id: string,
    changes: { schedule?: JobSchedule; systemEvent?: string; gracePeriodMs?: number | null },
  ): CronJob | null {
    const job = this.get(id);
    if (!job || job.status !== "active") return null;
    const newSchedule = changes.schedule ?? job.schedule;
    const newEvent = changes.systemEvent ?? job.systemEvent;
    const newGrace =
      changes.gracePeriodMs !== undefined ? changes.gracePeriodMs : job.gracePeriodMs;
    const newNext = nextFire(newSchedule, Date.now());
    if (!newNext) throw new Error("updated schedule would never fire");
    this.db
      .query(
        "UPDATE jobs SET system_event=?, schedule_json=?, next_fire_ms=?, grace_period_ms=? WHERE id=? AND status='active'",
      )
      .run(newEvent, JSON.stringify(newSchedule), newNext, newGrace, id);
    return {
      ...job,
      systemEvent: newEvent,
      schedule: newSchedule,
      nextFireMs: newNext,
      gracePeriodMs: newGrace,
    };
  }

  /**
   * Push an active row's nextFireMs to a later moment without changing
   * the systemEvent or schedule. Used by brown-nose fire deferral when
   * the concurrency cap is hit at fire time. Quietly no-ops if the job
   * has already been canceled/completed.
   */
  bumpNextFire(id: string, newFireAtMs: number): void {
    this.db
      .query("UPDATE jobs SET next_fire_ms=? WHERE id=? AND status='active'")
      .run(newFireAtMs, id);
  }

  /**
   * Defer a job that is currently mid-fire to a later moment. The
   * scheduler marks a once-job `done` BEFORE invoking its handler
   * (crash-safety), so by the time a fire handler decides to defer,
   * `bumpNextFire` — which only touches active rows — silently no-ops
   * and the job is lost. This variant revives a `done` row back to
   * `active` alongside the time bump. Canceled rows stay untouchable.
   * Returns true if a row was rescheduled.
   */
  deferMidFire(id: string, newFireAtMs: number): boolean {
    const res = this.db
      .query(
        "UPDATE jobs SET next_fire_ms=?, status='active' WHERE id=? AND status IN ('active','done')",
      )
      .run(newFireAtMs, id);
    return Number(res.changes) > 0;
  }

  listActive(sessionKey?: string): CronJob[] {
    const rows = sessionKey
      ? this.db
          .query(
            "SELECT * FROM jobs WHERE status='active' AND session_key = ? ORDER BY next_fire_ms ASC",
          )
          .all(sessionKey)
      : this.db.query("SELECT * FROM jobs WHERE status='active' ORDER BY next_fire_ms ASC").all();
    const out: CronJob[] = [];
    for (const row of rows as RawRow[]) {
      const job = this.hydrate(row);
      if (job) out.push(job);
    }
    return out;
  }

  nextDue(): CronJob | null {
    // Skip past any corrupt rows (hydrate quarantines them, so this loop
    // is bounded — each iteration either returns or removes one row).
    for (;;) {
      const row = this.db
        .query("SELECT * FROM jobs WHERE status='active' ORDER BY next_fire_ms ASC LIMIT 1")
        .get() as RawRow | undefined;
      if (!row) return null;
      const job = this.hydrate(row);
      if (job) return job;
    }
  }

  cancel(id: string): boolean {
    const res = this.db
      .query("UPDATE jobs SET status='canceled' WHERE id = ? AND status='active'")
      .run(id);
    return res.changes > 0;
  }

  /**
   * Hard-delete inactive rows whose `system_event` contains `pattern`.
   * Used by one-shot migrations / janitorial purges of historical
   * deprecated rows (e.g. legacy recovery-check envelopes). Returns
   * the count deleted. Refuses to delete active rows for safety.
   */
  hardDeleteInactiveByEventPattern(pattern: string): number {
    const res = this.db
      .query("DELETE FROM jobs WHERE status != 'active' AND system_event LIKE ?")
      .run(`%${pattern}%`);
    return Number(res.changes);
  }

  /**
   * Cancel any active self-poke jobs for this session. Called right after
   * an agent/team-completion event is scheduled so the poke — which was
   * only a safety net for the work that just finished — doesn't also fire
   * and trigger a redundant "already handled" reply.
   */
  cancelPokes(sessionKey: string): number {
    const res = this.db
      .query(
        "UPDATE jobs SET status='canceled' WHERE status='active' AND session_key = ? AND system_event LIKE 'Self-poke:%'",
      )
      .run(sessionKey);
    return Number(res.changes ?? 0);
  }

  markFired(job: CronJob, firedAtMs: number): CronJob {
    const next = nextFire(job.schedule, firedAtMs);
    const status: CronJob["status"] = job.schedule.kind === "once" || !next ? "done" : "active";
    this.db
      .query("UPDATE jobs SET last_fired_ms = ?, next_fire_ms = ?, status = ? WHERE id = ?")
      .run(firedAtMs, next, status, job.id);
    return { ...job, lastFiredMs: firedAtMs, nextFireMs: next, status };
  }

  close(): void {
    this.db.close();
  }
}

type RawRow = {
  id: string;
  session_key: string;
  system_event: string;
  schedule_json: string;
  next_fire_ms: number;
  created_at: number;
  last_fired_ms: number | null;
  status: CronJob["status"];
  grace_period_ms: number | null;
  attach_images_json: string | null;
};

/** Hydrate a DB row into a CronJob, or `null` if its schedule blob is
 * unreadable (corrupt / hand-edited / schema drift). Callers should
 * quarantine null rows so the scheduler doesn't trip over them again. */
function rowToJob(r: RawRow): CronJob | null {
  const schedule = parseJobSchedule(r.schedule_json);
  if (!schedule) {
    console.error(
      `[cron] job ${r.id} has an unreadable schedule_json — quarantining: ${r.schedule_json}`,
    );
    return null;
  }
  let attachImages: string[] | null = null;
  if (r.attach_images_json) {
    try {
      const parsed = JSON.parse(r.attach_images_json);
      if (Array.isArray(parsed))
        attachImages = parsed.filter((s): s is string => typeof s === "string");
    } catch {
      // Malformed JSON (shouldn't happen — we wrote it) — treat as no attachments.
    }
  }
  return {
    id: r.id,
    sessionKey: r.session_key,
    systemEvent: r.system_event,
    schedule,
    nextFireMs: r.next_fire_ms,
    createdAt: r.created_at,
    lastFiredMs: r.last_fired_ms,
    status: r.status,
    gracePeriodMs: r.grace_period_ms,
    attachImages,
  };
}
