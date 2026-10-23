import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { genId } from "../util/ids.ts";
import type { Agent, AgentInput, AgentLimits, AgentStatus } from "./types.ts";

/**
 * SQLite-backed store for sub-agents. Mirrors the cron/store.ts pattern so
 * the codebase has one style for persistent queues: create on init, WAL
 * mode, plain prepared statements, explicit row-to-type mapping.
 *
 * Schema columns for `team_id` / `role` are reserved for Phase 2 (agent
 * teams with orchestrator + workers) so the single-agent Phase 1 doesn't
 * require a later migration.
 */
export class AgentStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "agents.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        parent_session_key TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        spawned_at INTEGER NOT NULL,
        finished_at INTEGER,
        sandbox_path TEXT NOT NULL,
        result_path TEXT NOT NULL,
        log_path TEXT NOT NULL,
        exit_code INTEGER,
        team_id TEXT,
        role TEXT,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS agents_session_status_idx
        ON agents(parent_session_key, status);
      CREATE INDEX IF NOT EXISTS agents_team_idx ON agents(team_id);
    `);
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN cost_usd REAL");
    } catch {
      // Column already exists.
    }
    // Liveness: the runner stamps this on its CLI's output, so the reaper can
    // tell a quiet agent from a working one. Before it existed the reaper
    // went by age alone and killed 33 of 35 agents mid-work.
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN heartbeat_at INTEGER");
    } catch {
      // Column already exists.
    }
    // Why a run ended early (reaped, canceled), for the partial result and
    // for check_agent.
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN stop_reason TEXT");
    } catch {
      // Column already exists.
    }
    // One row per team whose team-done event went out: the claim that keeps
    // two members settling at the same moment from waking the parent twice.
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS team_done (team_id TEXT PRIMARY KEY, fired_at INTEGER NOT NULL)",
    );
  }

  create(
    input: AgentInput,
    paths: { id?: string; sandboxPath: string; resultPath: string; logPath: string },
  ): Agent {
    const agent: Agent = {
      id: paths.id ?? randomId(),
      parentSessionKey: input.parentSessionKey,
      task: input.task,
      status: "pending",
      pid: null,
      spawnedAt: Date.now(),
      finishedAt: null,
      sandboxPath: paths.sandboxPath,
      resultPath: paths.resultPath,
      logPath: paths.logPath,
      exitCode: null,
      teamId: input.teamId ?? null,
      role: input.role ?? null,
      deliveredAt: null,
      heartbeatAt: null,
      stopReason: null,
    };
    this.db
      .query(
        `INSERT INTO agents(id, parent_session_key, task, status, pid, spawned_at, finished_at,
         sandbox_path, result_path, log_path, exit_code, team_id, role, delivered_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        agent.id,
        agent.parentSessionKey,
        agent.task,
        agent.status,
        null,
        agent.spawnedAt,
        null,
        agent.sandboxPath,
        agent.resultPath,
        agent.logPath,
        null,
        agent.teamId,
        agent.role,
        null,
      );
    return agent;
  }

  get(id: string): Agent | null {
    const row = this.db.query("SELECT * FROM agents WHERE id = ?").get(id);
    return row ? rowToAgent(row as RawRow) : null;
  }

  list(filter: { parentSessionKey?: string; status?: AgentStatus; teamId?: string } = {}): Agent[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.parentSessionKey) {
      clauses.push("parent_session_key = ?");
      args.push(filter.parentSessionKey);
    }
    if (filter.status) {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    if (filter.teamId) {
      clauses.push("team_id = ?");
      args.push(filter.teamId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM agents ${where} ORDER BY spawned_at DESC`)
      .all(...args);
    return (rows as RawRow[]).map(rowToAgent);
  }

  /**
   * pending → running, for the runner that is starting. False when the row
   * was already settled (a slow start the reaper gave up on, or a cancel):
   * that runner must not start the model.
   */
  claimRunning(id: string, pid: number): boolean {
    const res = this.db
      .query("UPDATE agents SET status='running', pid=? WHERE id=? AND status='pending'")
      .run(pid, id);
    return Number(res.changes ?? 0) > 0;
  }

  /** The runner saw its CLI produce output. */
  heartbeat(id: string, atMs = Date.now()): void {
    this.db.query("UPDATE agents SET heartbeat_at=? WHERE id=? AND status='running'").run(atMs, id);
  }

  /**
   * Settle an agent that is still pending or running. The runner's exit, its
   * SIGTERM handler, the reaper, a spawn failure and the cancel tools can all
   * reach the same row at the same moment; only the caller that gets `true`
   * notifies the parent, so one agent never wakes it twice.
   */
  finishIfActive(
    id: string,
    status: AgentStatus,
    exitCode: number | null,
    stopReason: string | null = null,
  ): boolean {
    const res = this.db
      .query(
        `UPDATE agents SET status=?, finished_at=?, exit_code=?, pid=NULL,
           stop_reason=COALESCE(?, stop_reason)
         WHERE id=? AND status IN ('pending','running')`,
      )
      .run(status, Date.now(), exitCode, stopReason, id);
    return Number(res.changes ?? 0) > 0;
  }

  /** CLI-reported spend for this agent's run (from its result event). */
  setCostUsd(id: string, costUsd: number): void {
    this.db.query("UPDATE agents SET cost_usd=? WHERE id=?").run(costUsd, id);
  }

  markDelivered(id: string): void {
    this.db.query("UPDATE agents SET delivered_at=? WHERE id=?").run(Date.now(), id);
  }

  /**
   * Team members that never started (spawn failure, runner crashed before
   * claiming) settle as failed after `pendingStaleMs`, so one of them cannot
   * hold the team open. Members that are running are the reaper's to judge,
   * by their heartbeat: this used to fail every member older than 15
   * minutes, working or not, without stopping it.
   */
  failStalePending(teamId: string, pendingStaleMs: number): number {
    const now = Date.now();
    const res = this.db
      .query(
        `UPDATE agents SET status='failed', finished_at=?, exit_code=NULL, pid=NULL,
           stop_reason='never started'
         WHERE team_id=? AND status='pending' AND spawned_at < ?`,
      )
      .run(now, teamId, now - pendingStaleMs);
    return Number(res.changes ?? 0);
  }

  /** True for the one caller that gets to send this team's team-done event. */
  claimTeamDone(teamId: string): boolean {
    const res = this.db
      .query("INSERT OR IGNORE INTO team_done(team_id, fired_at) VALUES (?, ?)")
      .run(teamId, Date.now());
    return Number(res.changes ?? 0) > 0;
  }

  /**
   * Returns true if every non-canceled agent in the team has a terminal
   * status (done | failed). Used by the runner to decide whether to fire
   * a team-completion notification instead of a per-member one.
   */
  teamFullySettled(teamId: string): boolean {
    const rows = this.db
      .query("SELECT status FROM agents WHERE team_id = ? AND status != 'canceled'")
      .all(teamId) as Array<{ status: string }>;
    if (rows.length === 0) return false;
    return rows.every((r) => r.status === "done" || r.status === "failed");
  }

  /**
   * Agents the reaper should stop: pending past `pendingStaleMs` (never
   * started), running with no output for `idleMs`, or running past
   * `maxRunMs` whatever they are doing. A row from before heartbeats counts
   * its age from the spawn.
   */
  listStuck(opts: AgentLimits, now = Date.now()): Agent[] {
    const rows = this.db
      .query(
        `SELECT * FROM agents
         WHERE (status='pending' AND spawned_at < ?)
            OR (status='running' AND (COALESCE(heartbeat_at, spawned_at) < ? OR spawned_at < ?))`,
      )
      .all(now - opts.pendingStaleMs, now - opts.idleMs, now - opts.maxRunMs);
    return (rows as RawRow[]).map(rowToAgent);
  }

  /** Members of a team, oldest-spawned first (so orchestration order is preserved). */
  listTeam(teamId: string): Agent[] {
    const rows = this.db
      .query("SELECT * FROM agents WHERE team_id = ? ORDER BY spawned_at ASC")
      .all(teamId);
    return (rows as RawRow[]).map(rowToAgent);
  }
}

type RawRow = {
  id: string;
  parent_session_key: string;
  task: string;
  status: AgentStatus;
  pid: number | null;
  spawned_at: number;
  finished_at: number | null;
  sandbox_path: string;
  result_path: string;
  log_path: string;
  exit_code: number | null;
  team_id: string | null;
  role: string | null;
  delivered_at: number | null;
  heartbeat_at: number | null;
  stop_reason: string | null;
};

function rowToAgent(row: RawRow): Agent {
  return {
    id: row.id,
    parentSessionKey: row.parent_session_key,
    task: row.task,
    status: row.status,
    pid: row.pid,
    spawnedAt: row.spawned_at,
    finishedAt: row.finished_at,
    sandboxPath: row.sandbox_path,
    resultPath: row.result_path,
    logPath: row.log_path,
    exitCode: row.exit_code,
    teamId: row.team_id,
    role: row.role,
    deliveredAt: row.delivered_at,
    heartbeatAt: row.heartbeat_at ?? null,
    stopReason: row.stop_reason ?? null,
  };
}

function randomId(): string {
  return genId("agent");
}
