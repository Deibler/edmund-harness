/**
 * What started the turn a session is in: a scheduled job, or anything else.
 *
 * A computer-use server lives across turns (the warm worker keeps it), and
 * nothing tells it when one turn ends and the next begins. So the daemon
 * writes this record as each turn starts (runModel), and the server reads it
 * when the safety check asks what started the turn (request.ts). A message
 * that arrives during a scheduled turn changes nothing here; the turn that
 * message goes on to start overwrites it.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type TurnStart = {
  startedMs: number;
  /** The cron job whose firing started this turn, or null for anything else. */
  cronJob: string | null;
};

function turnPath(dataDir: string, sessionKey: string): string {
  return join(dataDir, "computer-use", "turns", `${encodeURIComponent(sessionKey)}.json`);
}

/**
 * The daemon's half: a turn for `sessionKey` is starting. If the record
 * cannot be written, the old one is removed rather than left to describe the
 * wrong turn; with none, the server says nothing started the turn.
 */
export function noteTurnStart(
  dataDir: string,
  sessionKey: string,
  cronJob: string | null,
  now: number = Date.now(),
): void {
  const path = turnPath(dataDir, sessionKey);
  const record: TurnStart = { startedMs: now, cronJob };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(path);
    } catch {}
    throw err;
  }
}

/** The turn `sessionKey` is in, as the daemon recorded it; null when there is no record. */
export function readTurn(dataDir: string, sessionKey: string): TurnStart | null {
  try {
    const t = JSON.parse(readFileSync(turnPath(dataDir, sessionKey), "utf8")) as TurnStart;
    return typeof t?.startedMs === "number" ? t : null;
  } catch {
    return null;
  }
}
