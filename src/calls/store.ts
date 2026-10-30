/**
 * data/calls.db — every call, both sides of what was said, the notes taken,
 * and the queue of calls the model has asked for.
 *
 * Two processes write here: the daemon (calls, utterances, notes) and the MCP
 * server (call requests, from the facetime_call tool, which runs in the turn's
 * own subprocess and cannot reach the daemon's memory). WAL through openDb
 * makes that safe.
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import type { SessionKey } from "../sessions/key.ts";
import type { CallConversation, CallDirection, CallRecord, Utterance } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  provider_call   TEXT,
  direction       TEXT NOT NULL,
  session_key     TEXT NOT NULL,
  chat_guid       TEXT NOT NULL,
  conversation    TEXT NOT NULL,   -- CallConversation JSON
  requested_by    TEXT,
  reason          TEXT,
  started_at      INTEGER NOT NULL,
  answered_at     INTEGER,
  ended_at        INTEGER,
  end_reason      TEXT,
  handed_off      TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS calls_session ON calls(session_key, started_at);

CREATE TABLE IF NOT EXISTS utterances (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id  TEXT NOT NULL,
  speaker  TEXT NOT NULL,           -- caller | edmund
  text     TEXT NOT NULL,
  at_ms    INTEGER NOT NULL,
  heard    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS utterances_call ON utterances(call_id, id);

CREATE TABLE IF NOT EXISTS call_notes (
  call_id    TEXT PRIMARY KEY,
  notes      TEXT NOT NULL,
  model      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS call_requests (
  id            TEXT PRIMARY KEY,
  requested_by  TEXT NOT NULL,
  session_key   TEXT NOT NULL,      -- the callee's conversation
  handle        TEXT NOT NULL,      -- the resolved handle to dial
  reason        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  claimed_at    INTEGER,
  outcome       TEXT
);

CREATE TABLE IF NOT EXISTS call_commands (
  id           TEXT PRIMARY KEY,
  session_key  TEXT NOT NULL,       -- the conversation whose call it acts on
  command      TEXT NOT NULL,       -- hangup
  created_at   INTEGER NOT NULL,
  claimed_at   INTEGER
);
`;

type CallRow = {
  id: string;
  provider: string;
  direction: CallDirection;
  conversation: string;
  requested_by: string | null;
  reason: string | null;
  started_at: number;
  answered_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  handed_off: string;
};

export type CallCommand = { id: string; sessionKey: SessionKey; command: "hangup" };

export type CallRequest = {
  id: string;
  requestedBy: SessionKey;
  sessionKey: SessionKey;
  handle: string;
  reason: string;
  createdAtMs: number;
};

function toRecord(row: CallRow): CallRecord {
  return {
    id: row.id,
    provider: row.provider,
    direction: row.direction,
    conversation: JSON.parse(row.conversation) as CallConversation,
    requestedBy: row.requested_by,
    reason: row.reason,
    startedAtMs: row.started_at,
    answeredAtMs: row.answered_at,
    endedAtMs: row.ended_at,
    endReason: row.end_reason,
    handedOff: JSON.parse(row.handed_off) as string[],
  };
}

export function callsDbPath(dataDir: string): string {
  return join(dataDir, "calls.db");
}

export class CallStore {
  private readonly db: Database;

  constructor(dataDir: string) {
    this.db = openDb(callsDbPath(dataDir));
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createCall(call: CallRecord, providerCallId: string | null): void {
    this.db
      .query(
        `INSERT INTO calls (id, provider, provider_call, direction, session_key, chat_guid,
           conversation, requested_by, reason, started_at, handed_off)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.id,
        call.provider,
        providerCallId,
        call.direction,
        call.conversation.sessionKey,
        call.conversation.chatGuid,
        JSON.stringify(call.conversation),
        call.requestedBy,
        call.reason,
        call.startedAtMs,
        JSON.stringify(call.handedOff),
      );
  }

  markAnswered(id: string, atMs: number): void {
    this.db.query("UPDATE calls SET answered_at = ? WHERE id = ?").run(atMs, id);
  }

  markEnded(id: string, atMs: number, reason: string): void {
    this.db
      .query("UPDATE calls SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
      .run(atMs, reason, id);
  }

  setHandedOff(id: string, agentIds: string[]): void {
    this.db.query("UPDATE calls SET handed_off = ? WHERE id = ?").run(JSON.stringify(agentIds), id);
  }

  getCall(id: string): CallRecord | null {
    const row = this.db.query<CallRow, [string]>("SELECT * FROM calls WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  /** Calls in a conversation that ended at or after `sinceMs`, oldest first. */
  callsSince(sessionKey: SessionKey, sinceMs: number): CallRecord[] {
    return this.db
      .query<CallRow, [string, number]>(
        "SELECT * FROM calls WHERE session_key = ? AND ended_at >= ? ORDER BY started_at",
      )
      .all(sessionKey, sinceMs)
      .map(toRecord);
  }

  /** A conversation's most recent calls, newest first, finished or not. */
  callsInConversation(sessionKey: SessionKey, limit: number): CallRecord[] {
    return this.db
      .query<CallRow, [string, number]>(
        "SELECT * FROM calls WHERE session_key = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(sessionKey, limit)
      .map(toRecord);
  }

  addUtterance(callId: string, utterance: Utterance): void {
    this.db
      .query("INSERT INTO utterances (call_id, speaker, text, at_ms, heard) VALUES (?, ?, ?, ?, ?)")
      .run(callId, utterance.speaker, utterance.text, utterance.atMs, utterance.heard ? 1 : 0);
  }

  utterances(callId: string): Utterance[] {
    return this.db
      .query<
        { speaker: Utterance["speaker"]; text: string; at_ms: number; heard: number },
        [string]
      >("SELECT speaker, text, at_ms, heard FROM utterances WHERE call_id = ? ORDER BY id")
      .all(callId)
      .map((row) => ({
        speaker: row.speaker,
        text: row.text,
        atMs: row.at_ms,
        heard: row.heard === 1,
      }));
  }

  setNotes(callId: string, notes: string, model: string | null): void {
    this.db
      .query(
        `INSERT INTO call_notes (call_id, notes, model, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(call_id) DO UPDATE SET notes = excluded.notes, model = excluded.model,
           created_at = excluded.created_at`,
      )
      .run(callId, notes, model, Date.now());
  }

  notes(callId: string): string | null {
    return (
      this.db
        .query<{ notes: string }, [string]>("SELECT notes FROM call_notes WHERE call_id = ?")
        .get(callId)?.notes ?? null
    );
  }

  addRequest(request: CallRequest): void {
    this.db
      .query(
        `INSERT INTO call_requests (id, requested_by, session_key, handle, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.requestedBy,
        request.sessionKey,
        request.handle,
        request.reason,
        request.createdAtMs,
      );
  }

  /** Unclaimed requests, claimed in the same transaction so each runs once. */
  claimRequests(nowMs: number): CallRequest[] {
    return this.db.transaction(() => {
      const rows = this.db
        .query<
          {
            id: string;
            requested_by: string;
            session_key: string;
            handle: string;
            reason: string;
            created_at: number;
          },
          []
        >("SELECT * FROM call_requests WHERE claimed_at IS NULL ORDER BY created_at")
        .all();
      for (const row of rows) {
        this.db.query("UPDATE call_requests SET claimed_at = ? WHERE id = ?").run(nowMs, row.id);
      }
      return rows.map((row) => ({
        id: row.id,
        requestedBy: row.requested_by,
        sessionKey: row.session_key,
        handle: row.handle,
        reason: row.reason,
        createdAtMs: row.created_at,
      }));
    })();
  }

  finishRequest(id: string, outcome: string): void {
    this.db.query("UPDATE call_requests SET outcome = ? WHERE id = ?").run(outcome, id);
  }

  addCommand(id: string, sessionKey: SessionKey, command: CallCommand["command"]): void {
    this.db
      .query("INSERT INTO call_commands (id, session_key, command, created_at) VALUES (?, ?, ?, ?)")
      .run(id, sessionKey, command, Date.now());
  }

  claimCommands(nowMs: number): CallCommand[] {
    return this.db.transaction(() => {
      const rows = this.db
        .query<{ id: string; session_key: string; command: string }, []>(
          "SELECT id, session_key, command FROM call_commands WHERE claimed_at IS NULL ORDER BY created_at",
        )
        .all();
      for (const row of rows) {
        this.db.query("UPDATE call_commands SET claimed_at = ? WHERE id = ?").run(nowMs, row.id);
      }
      return rows.map((row) => ({
        id: row.id,
        sessionKey: row.session_key,
        command: row.command as CallCommand["command"],
      }));
    })();
  }
}
