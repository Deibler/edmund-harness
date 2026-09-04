import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { genId } from "../util/ids.ts";

/**
 * Errands — tracked round-trip asks between sessions.
 *
 * `message_contact` is fire-and-forget: a one-way relay. An errand is the
 * concierge upgrade — "ask Mom if Saturday works *and bring me the
 * answer*". The asking session records the errand, the receiving
 * session's envelope carries a report-back instruction, and
 * `report_errand` closes the loop by firing the answer into the
 * originator's session. A follow-up cron in the originator's session
 * keeps unanswered errands from silently dying.
 *
 * Privacy stance: an errand carries exactly what the asker chose to send
 * (the question) and what the target's Edmund chose to report (the
 * answer). No session history crosses the boundary.
 */

type ErrandStatus = "active" | "answered" | "canceled";

export type Errand = {
  id: string;
  originatorSession: string;
  originatorName: string;
  targetSession: string;
  targetName: string;
  ask: string;
  status: ErrandStatus;
  createdMs: number;
  answeredMs: number | null;
  answer: string | null;
  /** Cron job id of the originator-side follow-up nudge, if scheduled. */
  followupCronId: string | null;
};

type Row = {
  id: string;
  originator_session: string;
  originator_name: string;
  target_session: string;
  target_name: string;
  ask: string;
  status: string;
  created_ms: number;
  answered_ms: number | null;
  answer: string | null;
  followup_cron_id: string | null;
};

export class ErrandStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, "errands.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS errands (
        id TEXT PRIMARY KEY,
        originator_session TEXT NOT NULL,
        originator_name TEXT NOT NULL,
        target_session TEXT NOT NULL,
        target_name TEXT NOT NULL,
        ask TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_ms INTEGER NOT NULL,
        answered_ms INTEGER,
        answer TEXT,
        followup_cron_id TEXT
      );
      CREATE INDEX IF NOT EXISTS errands_originator_idx ON errands(originator_session, status);
      CREATE INDEX IF NOT EXISTS errands_target_idx ON errands(target_session, status);
    `);
  }

  create(args: {
    /** Explicit id when the caller pre-baked it into an envelope; omit to generate. */
    id?: string;
    originatorSession: string;
    originatorName: string;
    targetSession: string;
    targetName: string;
    ask: string;
    followupCronId: string | null;
  }): Errand {
    const errand: Errand = {
      id: args.id ?? genId("err"),
      originatorSession: args.originatorSession,
      originatorName: args.originatorName,
      targetSession: args.targetSession,
      targetName: args.targetName,
      ask: args.ask,
      status: "active",
      createdMs: Date.now(),
      answeredMs: null,
      answer: null,
      followupCronId: args.followupCronId,
    };
    this.db
      .query(
        `INSERT INTO errands
           (id, originator_session, originator_name, target_session, target_name,
            ask, status, created_ms, answered_ms, answer, followup_cron_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        errand.id,
        errand.originatorSession,
        errand.originatorName,
        errand.targetSession,
        errand.targetName,
        errand.ask,
        errand.status,
        errand.createdMs,
        errand.followupCronId,
      );
    return errand;
  }

  get(id: string): Errand | null {
    const row = this.db.query("SELECT * FROM errands WHERE id = ?").get(id) as Row | null;
    return row ? fromRow(row) : null;
  }

  /** Errands this session sent out (any status, newest first, capped). */
  sentBy(sessionKey: string, limit = 20): Errand[] {
    const rows = this.db
      .query("SELECT * FROM errands WHERE originator_session = ? ORDER BY created_ms DESC LIMIT ?")
      .all(sessionKey, limit) as Row[];
    return rows.map(fromRow);
  }

  /** Open errands waiting on this session to report back. */
  owedBy(sessionKey: string): Errand[] {
    const rows = this.db
      .query(
        "SELECT * FROM errands WHERE target_session = ? AND status = 'active' ORDER BY created_ms ASC",
      )
      .all(sessionKey) as Row[];
    return rows.map(fromRow);
  }

  markAnswered(id: string, answer: string): boolean {
    const res = this.db
      .query(
        "UPDATE errands SET status='answered', answer=?, answered_ms=? WHERE id=? AND status='active'",
      )
      .run(answer, Date.now(), id);
    return Number(res.changes) > 0;
  }

  markCanceled(id: string): boolean {
    const res = this.db
      .query("UPDATE errands SET status='canceled' WHERE id=? AND status='active'")
      .run(id);
    return Number(res.changes) > 0;
  }

  setFollowupCronId(id: string, cronId: string | null): void {
    this.db.query("UPDATE errands SET followup_cron_id=? WHERE id=?").run(cronId, id);
  }
}

function fromRow(row: Row): Errand {
  return {
    id: row.id,
    originatorSession: row.originator_session,
    originatorName: row.originator_name,
    targetSession: row.target_session,
    targetName: row.target_name,
    ask: row.ask,
    status: row.status as ErrandStatus,
    createdMs: row.created_ms,
    answeredMs: row.answered_ms,
    answer: row.answer,
    followupCronId: row.followup_cron_id,
  };
}

/** System event fired into the originator's session when the answer lands. */
export function errandAnsweredEvent(errand: Errand, answer: string): string {
  return [
    `[Errand answered ${errand.id}]`,
    "",
    `You asked ${errand.targetName}: "${errand.ask}"`,
    `Their answer, reported back: "${answer}"`,
    "",
    "Pass this along to the user naturally — lead with the answer itself, not the mechanics.",
    "If this resolves what they were coordinating (a time, a yes/no, a decision), connect the",
    `dots in one line. If it changes a plan you're tracking, update notes/reminders accordingly.`,
  ].join("\n");
}

/** Follow-up event in the originator's session when the deadline passes unanswered. */
export function errandFollowupEvent(errand: {
  id: string;
  targetName: string;
  ask: string;
}): string {
  return [
    `[Errand follow-up ${errand.id}]`,
    "",
    `You asked ${errand.targetName} "${errand.ask}" on the user's behalf and haven't heard back.`,
    "Check list_errands first. If it was answered or canceled in the meantime: output NOTHING",
    `(empty turn, no text). If it's still open, pick ONE:`,
    `- Nudge ${errand.targetName} once via message_contact (only if you haven't nudged before).`,
    `- Tell the user it's still open and ask how they want to proceed.`,
    "- cancel_errand if events made it moot.",
  ].join("\n");
}
