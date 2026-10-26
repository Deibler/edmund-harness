import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Need, Plan } from "./filament.ts";

/**
 * Print jobs, the approvals that gate them, the watches that wake Edmund, and
 * an audit trail. One SQLite file in the data dir, opened by the daemon's
 * runtime and by each session's tool process (WAL keeps them out of each
 * other's way).
 */

export type JobStatus =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "declined"
  | "starting"
  | "printing"
  | "finished"
  | "failed"
  | "cancelled";

export type Job = {
  id: number;
  token: string;
  title: string;
  requester: string;
  requesterHandle: string;
  originSession: string;
  originChat: string;
  /** The print-ready .gcode.3mf. */
  file: string;
  /** The model it was sliced from, for re-slicing. */
  source: string;
  plate: number;
  plateType: string;
  needs: Need[];
  /** Filament pins the person accepted: project filament index -> tray id. */
  prefer: Record<number, number>;
  estimateS: number;
  weightG: number;
  settings: Record<string, unknown>;
  preview: string;
  status: JobStatus;
  designNote: string;
  remoteName: string;
  createdMs: number;
  updatedMs: number;
  startedMs: number | null;
  endedMs: number | null;
  endNote: string;
  finalPhoto: string;
  timelapse: string;
};

/**
 * What the approver is asked: to start a print, cancel or resume one, or
 * (when Edmund's plate check is unsure) to confirm from a photo that the
 * plate is clear.
 */
export type ApprovalAction = "start" | "cancel" | "resume" | "plate";
export type ApprovalStatus = "pending" | "approved" | "declined" | "used" | "expired";

export type Approval = {
  id: number;
  jobId: number | null;
  action: ApprovalAction;
  chatGuid: string;
  sessionKey: string;
  askedMs: number;
  askText: string;
  askGuid: string;
  status: ApprovalStatus;
  decidedMs: number | null;
  decidedBy: string;
  decidedText: string;
  /** What the AMS held for this job when the ask went out. */
  trays: string;
  plan: Plan | null;
  /** The print this cancel or resume is about, by name, when there is no job. */
  target: string;
  /** For a plate confirmation: the capture time (frame id) of the photo the approver was shown. */
  frameMs: number | null;
};

export type WatchKind = "progress" | "layer" | "finish" | "state" | "error" | "filament";

export type Watch = {
  id: number;
  sessionKey: string;
  kind: WatchKind;
  threshold: number | null;
  /** Tray id for a filament watch on one slot. */
  slot: number | null;
  note: string;
  jobId: number | null;
  /** The print this watch belongs to; a progress watch never fires on a different print. */
  printKey: string;
  createdMs: number;
  firedMs: number | null;
  repeat: boolean;
  active: boolean;
  /** Set automatically by a print start rather than asked for. */
  auto: boolean;
  /** For filament watches: what was loaded when the watch was set (or last fired). */
  baseline: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  requester TEXT NOT NULL DEFAULT '',
  requester_handle TEXT NOT NULL DEFAULT '',
  origin_session TEXT NOT NULL,
  origin_chat TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  plate INTEGER NOT NULL DEFAULT 1,
  plate_type TEXT NOT NULL DEFAULT '',
  needs TEXT NOT NULL DEFAULT '[]',
  prefer TEXT NOT NULL DEFAULT '{}',
  estimate_s INTEGER NOT NULL DEFAULT 0,
  weight_g REAL NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  preview TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  design_note TEXT NOT NULL DEFAULT '',
  remote_name TEXT NOT NULL DEFAULT '',
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  started_ms INTEGER,
  ended_ms INTEGER,
  end_note TEXT NOT NULL DEFAULT '',
  final_photo TEXT NOT NULL DEFAULT '',
  timelapse TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  action TEXT NOT NULL,
  chat_guid TEXT NOT NULL,
  session_key TEXT NOT NULL,
  asked_ms INTEGER NOT NULL,
  ask_text TEXT NOT NULL DEFAULT '',
  ask_guid TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_ms INTEGER,
  decided_by TEXT NOT NULL DEFAULT '',
  decided_text TEXT NOT NULL DEFAULT '',
  trays TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  frame_ms INTEGER
);
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  threshold REAL,
  slot INTEGER,
  note TEXT NOT NULL DEFAULT '',
  job_id INTEGER,
  print_key TEXT NOT NULL DEFAULT '',
  created_ms INTEGER NOT NULL,
  fired_ms INTEGER,
  repeat INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  auto INTEGER NOT NULL DEFAULT 0,
  baseline TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ms INTEGER NOT NULL,
  job_id INTEGER,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(status);
CREATE INDEX IF NOT EXISTS watches_active ON watches(active);
`;

type Row = Record<string, unknown>;

const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

function toJob(r: Row): Job {
  return {
    id: Number(r.id),
    token: String(r.token),
    title: String(r.title),
    requester: String(r.requester),
    requesterHandle: String(r.requester_handle),
    originSession: String(r.origin_session),
    originChat: String(r.origin_chat),
    file: String(r.file),
    source: String(r.source),
    plate: Number(r.plate),
    plateType: String(r.plate_type),
    needs: json<Need[]>(r.needs, []),
    prefer: json<Record<number, number>>(r.prefer, {}),
    estimateS: Number(r.estimate_s),
    weightG: Number(r.weight_g),
    settings: json<Record<string, unknown>>(r.settings, {}),
    preview: String(r.preview),
    status: String(r.status) as JobStatus,
    designNote: String(r.design_note),
    remoteName: String(r.remote_name),
    createdMs: Number(r.created_ms),
    updatedMs: Number(r.updated_ms),
    startedMs: r.started_ms == null ? null : Number(r.started_ms),
    endedMs: r.ended_ms == null ? null : Number(r.ended_ms),
    endNote: String(r.end_note),
    finalPhoto: String(r.final_photo),
    timelapse: String(r.timelapse),
  };
}

function toApproval(r: Row): Approval {
  return {
    id: Number(r.id),
    jobId: r.job_id == null ? null : Number(r.job_id),
    action: String(r.action) as ApprovalAction,
    chatGuid: String(r.chat_guid),
    sessionKey: String(r.session_key),
    askedMs: Number(r.asked_ms),
    askText: String(r.ask_text),
    askGuid: String(r.ask_guid),
    status: String(r.status) as ApprovalStatus,
    decidedMs: r.decided_ms == null ? null : Number(r.decided_ms),
    decidedBy: String(r.decided_by),
    decidedText: String(r.decided_text),
    trays: String(r.trays),
    plan: json<Plan | null>(r.plan, null),
    target: String(r.target),
    frameMs: r.frame_ms == null ? null : Number(r.frame_ms),
  };
}

function toWatch(r: Row): Watch {
  return {
    id: Number(r.id),
    sessionKey: String(r.session_key),
    kind: String(r.kind) as WatchKind,
    threshold: r.threshold == null ? null : Number(r.threshold),
    slot: r.slot == null ? null : Number(r.slot),
    note: String(r.note),
    jobId: r.job_id == null ? null : Number(r.job_id),
    printKey: String(r.print_key),
    createdMs: Number(r.created_ms),
    firedMs: r.fired_ms == null ? null : Number(r.fired_ms),
    repeat: Number(r.repeat) === 1,
    active: Number(r.active) === 1,
    auto: Number(r.auto) === 1,
    baseline: String(r.baseline ?? ""),
  };
}

export function printerDir(dataDir: string): string {
  return join(dataDir, "printer");
}

export class PrinterStore {
  readonly db: Database;

  constructor(dataDir: string) {
    const dir = printerDir(dataDir);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "printer.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    // Columns added after a table was first created.
    const cols = (this.db.query("PRAGMA table_info(approvals)").all() as Row[]).map((c) =>
      String(c.name),
    );
    if (!cols.includes("frame_ms"))
      this.db.exec("ALTER TABLE approvals ADD COLUMN frame_ms INTEGER");
  }

  close(): void {
    this.db.close();
  }

  log(kind: string, detail: string, jobId: number | null = null): void {
    this.db
      .query("INSERT INTO events (ms, job_id, kind, detail) VALUES (?, ?, ?, ?)")
      .run(Date.now(), jobId, kind, detail.slice(0, 4000));
  }

  events(jobId: number | null, limit = 50): Array<{ ms: number; kind: string; detail: string }> {
    const rows =
      jobId === null
        ? this.db.query("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit)
        : this.db
            .query("SELECT * FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?")
            .all(jobId, limit);
    return (rows as Row[]).map((r) => ({
      ms: Number(r.ms),
      kind: String(r.kind),
      detail: String(r.detail),
    }));
  }

  /* ── jobs ─────────────────────────────────────────────────────────────── */

  createJob(j: {
    title: string;
    requester: string;
    requesterHandle: string;
    originSession: string;
    originChat: string;
    file: string;
    source: string;
    plate: number;
    plateType: string;
    needs: Need[];
    estimateS: number;
    weightG: number;
    settings: Record<string, unknown>;
    preview: string;
  }): Job {
    const now = Date.now();
    const token = randomBytes(16).toString("hex");
    const r = this.db
      .query(
        `INSERT INTO jobs (token, title, requester, requester_handle, origin_session, origin_chat, file, source,
           plate, plate_type, needs, estimate_s, weight_g, settings, preview, status, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING id`,
      )
      .get(
        token,
        j.title,
        j.requester,
        j.requesterHandle,
        j.originSession,
        j.originChat,
        j.file,
        j.source,
        j.plate,
        j.plateType,
        JSON.stringify(j.needs),
        Math.round(j.estimateS),
        j.weightG,
        JSON.stringify(j.settings),
        j.preview,
        now,
        now,
      ) as Row;
    const job = this.job(Number(r.id))!;
    this.log("job_created", `${job.title} for ${job.requester || "unknown"}`, job.id);
    return job;
  }

  job(id: number): Job | null {
    const r = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as Row | null;
    return r ? toJob(r) : null;
  }

  jobByToken(token: string): Job | null {
    const r = this.db.query("SELECT * FROM jobs WHERE token = ?").get(token) as Row | null;
    return r ? toJob(r) : null;
  }

  jobs(opts: { session?: string; limit?: number; open?: boolean } = {}): Job[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.session) {
      where.push("origin_session = ?");
      args.push(opts.session);
    }
    if (opts.open) where.push("status NOT IN ('finished','failed','cancelled','declined')");
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    return (this.db.query(sql).all(...args, opts.limit ?? 20) as Row[]).map(toJob);
  }

  /** The job the printer is working on now, if Edmund started it. */
  activeJob(): Job | null {
    const r = this.db
      .query("SELECT * FROM jobs WHERE status IN ('starting','printing') ORDER BY id DESC LIMIT 1")
      .get() as Row | null;
    return r ? toJob(r) : null;
  }

  updateJob(id: number, patch: Partial<Omit<Job, "id" | "token" | "createdMs">>): void {
    const cols: Record<string, unknown> = {
      title: patch.title,
      file: patch.file,
      source: patch.source,
      plate: patch.plate,
      plate_type: patch.plateType,
      needs: patch.needs ? JSON.stringify(patch.needs) : undefined,
      prefer: patch.prefer ? JSON.stringify(patch.prefer) : undefined,
      estimate_s: patch.estimateS === undefined ? undefined : Math.round(patch.estimateS),
      weight_g: patch.weightG,
      settings: patch.settings ? JSON.stringify(patch.settings) : undefined,
      preview: patch.preview,
      status: patch.status,
      design_note: patch.designNote,
      remote_name: patch.remoteName,
      started_ms: patch.startedMs,
      ended_ms: patch.endedMs,
      end_note: patch.endNote,
      final_photo: patch.finalPhoto,
      timelapse: patch.timelapse,
    };
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (set.length === 0) return;
    this.db
      .query(
        `UPDATE jobs SET ${set.map(([k]) => `${k} = ?`).join(", ")}, updated_ms = ? WHERE id = ?`,
      )
      .run(...(set.map(([, v]) => v) as Array<string | number | null>), Date.now(), id);
  }

  /** Move a job from one status to another only if it is still in the first. True if this caller won. */
  transition(id: number, from: JobStatus[], to: JobStatus): boolean {
    const r = this.db
      .query(
        `UPDATE jobs SET status = ?, updated_ms = ? WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
      )
      .run(to, Date.now(), id, ...from);
    return r.changes === 1;
  }

  /* ── approvals ───────────────────────────────────────────────────────── */

  createApproval(a: {
    jobId: number | null;
    action: ApprovalAction;
    chatGuid: string;
    sessionKey: string;
    askedMs: number;
    askText: string;
    trays: string;
    plan: Plan | null;
    target?: string;
    frameMs?: number | null;
  }): Approval {
    // A new ask for the same job and action replaces any earlier one.
    this.db
      .query(
        `UPDATE approvals SET status = 'expired' WHERE status IN ('pending','approved') AND action = ?
           AND ((job_id IS NULL AND ? IS NULL) OR job_id = ?)`,
      )
      .run(a.action, a.jobId, a.jobId);
    const r = this.db
      .query(
        `INSERT INTO approvals (job_id, action, chat_guid, session_key, asked_ms, ask_text, trays, plan, target, frame_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        a.jobId,
        a.action,
        a.chatGuid,
        a.sessionKey,
        a.askedMs,
        a.askText,
        a.trays,
        a.plan ? JSON.stringify(a.plan) : "",
        a.target ?? "",
        a.frameMs ?? null,
      ) as Row;
    return this.approval(Number(r.id))!;
  }

  approval(id: number): Approval | null {
    const r = this.db.query("SELECT * FROM approvals WHERE id = ?").get(id) as Row | null;
    return r ? toApproval(r) : null;
  }

  /** The newest ask for this job and action that is still live (pending or approved). */
  liveApproval(jobId: number | null, action: ApprovalAction): Approval | null {
    const r = this.db
      .query(
        `SELECT * FROM approvals WHERE action = ? AND status IN ('pending','approved')
           AND ((job_id IS NULL AND ? IS NULL) OR job_id = ?) ORDER BY id DESC LIMIT 1`,
      )
      .get(action, jobId, jobId) as Row | null;
    return r ? toApproval(r) : null;
  }

  pendingApprovals(): Approval[] {
    return (
      this.db.query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all() as Row[]
    ).map(toApproval);
  }

  setAskGuid(id: number, guid: string): void {
    this.db.query("UPDATE approvals SET ask_guid = ? WHERE id = ?").run(guid, id);
  }

  decide(
    id: number,
    status: "approved" | "declined",
    by: string,
    text: string,
    ms: number,
  ): boolean {
    const r = this.db
      .query(
        "UPDATE approvals SET status = ?, decided_ms = ?, decided_by = ?, decided_text = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, ms, by, text.slice(0, 500), id);
    return r.changes === 1;
  }

  /** Spend an approval. True only for the one caller that moved it from approved to used. */
  consume(id: number): boolean {
    return (
      this.db
        .query("UPDATE approvals SET status = 'used' WHERE id = ? AND status = 'approved'")
        .run(id).changes === 1
    );
  }

  /** Give back an approval whose print never started, so the same yes can be used again. */
  restore(id: number): void {
    this.db
      .query("UPDATE approvals SET status = 'approved' WHERE id = ? AND status = 'used'")
      .run(id);
  }

  expire(id: number): void {
    this.db
      .query(
        "UPDATE approvals SET status = 'expired' WHERE id = ? AND status IN ('pending','approved')",
      )
      .run(id);
  }

  /* ── watches ─────────────────────────────────────────────────────────── */

  addWatch(w: {
    sessionKey: string;
    kind: WatchKind;
    threshold?: number | null;
    slot?: number | null;
    note?: string;
    jobId?: number | null;
    printKey?: string;
    repeat?: boolean;
    auto?: boolean;
    baseline?: string;
  }): Watch {
    const r = this.db
      .query(
        `INSERT INTO watches (session_key, kind, threshold, slot, note, job_id, print_key, created_ms, repeat, auto, baseline)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        w.sessionKey,
        w.kind,
        w.threshold ?? null,
        w.slot ?? null,
        w.note ?? "",
        w.jobId ?? null,
        w.printKey ?? "",
        Date.now(),
        w.repeat ? 1 : 0,
        w.auto ? 1 : 0,
        w.baseline ?? "",
      ) as Row;
    return this.watch(Number(r.id))!;
  }

  watch(id: number): Watch | null {
    const r = this.db.query("SELECT * FROM watches WHERE id = ?").get(id) as Row | null;
    return r ? toWatch(r) : null;
  }

  activeWatches(session?: string): Watch[] {
    const rows = session
      ? this.db
          .query("SELECT * FROM watches WHERE active = 1 AND session_key = ? ORDER BY id")
          .all(session)
      : this.db.query("SELECT * FROM watches WHERE active = 1 ORDER BY id").all();
    return (rows as Row[]).map(toWatch);
  }

  /** Record a firing; a one-shot watch goes inactive. True if this call fired it. */
  markFired(id: number, ms: number): boolean {
    const w = this.watch(id);
    if (!w?.active) return false;
    if (w.repeat) {
      this.db.query("UPDATE watches SET fired_ms = ? WHERE id = ?").run(ms, id);
      return true;
    }
    return (
      this.db
        .query("UPDATE watches SET fired_ms = ?, active = 0 WHERE id = ? AND active = 1")
        .run(ms, id).changes === 1
    );
  }

  setBaseline(id: number, baseline: string): void {
    this.db.query("UPDATE watches SET baseline = ? WHERE id = ?").run(baseline, id);
  }

  /** Tie a watch set between prints to the print that just started. */
  bindPrint(id: number, printKey: string): void {
    this.db
      .query("UPDATE watches SET print_key = ? WHERE id = ? AND print_key = ''")
      .run(printKey, id);
  }

  removeWatch(id: number, session: string): boolean {
    return (
      this.db
        .query("UPDATE watches SET active = 0 WHERE id = ? AND session_key = ? AND active = 1")
        .run(id, session).changes === 1
    );
  }

  /** Watches tied to a print end with it. */
  endPrintWatches(printKey: string): void {
    this.db
      .query("UPDATE watches SET active = 0 WHERE print_key = ? AND kind IN ('progress','layer')")
      .run(printKey);
  }
}
