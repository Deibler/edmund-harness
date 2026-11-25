/**
 * What the watch has decided that other parts must respect: which chats are
 * paused, whether the machine is locked down, and which shapes the operator
 * has said are fine.
 *
 * It is a small file because more than one process reads it: the daemon,
 * each conversation's tool server, and the command line. Each rereads it
 * only when it has changed. It sits low in the layering so that the model
 * runner can ask "is this chat paused" without knowing the watch exists.
 *
 * Everything here is undone by the operator: `OK` or `UNDO` to an alert,
 * `edmund watch resume`, `edmund lockdown off`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../util/atomic-write.ts";

export type Lockdown = {
  since: number;
  by: string;
  /** What was taken down, so that `off` can put it back. */
  restore: { kind: string; detail: string; command?: string }[];
};

export type WatchState = {
  /** Chats that may not start a turn, each with why and since when. */
  paused: Record<string, { since: number; why: string; incident?: string }>;
  lockdown: Lockdown | null;
  /** Patterns the operator has allowed: kind|target|session, each with when. */
  allowed: Record<string, number>;
  /** Credentials and the sites they have been sent to before: name>site. */
  sent: string[];
};

const EMPTY: WatchState = { paused: {}, lockdown: null, allowed: {}, sent: [] };

export const watchDir = (dataDir: string) => join(dataDir, "watch");
const stateFile = (dataDir: string) => join(watchDir(dataDir), "state.json");

const cache = new Map<string, { mtimeMs: number; state: WatchState }>();

/** The state as it is on disk now. A missing or unreadable file is "nothing decided". */
export function readWatchState(dataDir: string): WatchState {
  const file = stateFile(dataDir);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return EMPTY;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.state;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<WatchState>;
    const state: WatchState = {
      paused: raw.paused ?? {},
      lockdown: raw.lockdown ?? null,
      allowed: raw.allowed ?? {},
      sent: Array.isArray(raw.sent) ? raw.sent : [],
    };
    cache.set(file, { mtimeMs, state });
    return state;
  } catch {
    return EMPTY;
  }
}

/** Change the state: read what is there, apply the change, write it back whole. */
export function updateWatchState(dataDir: string, change: (state: WatchState) => void): WatchState {
  const file = stateFile(dataDir);
  cache.delete(file);
  const current = existsSync(file) ? readWatchState(dataDir) : EMPTY;
  const next: WatchState = structuredClone(current);
  change(next);
  atomicWriteFileSync(file, `${JSON.stringify(next, null, 1)}\n`);
  cache.delete(file);
  return next;
}

/** Why a chat may not start a turn, or null when it may. */
export function pausedReason(dataDir: string, sessionKey: string): string | null {
  return readWatchState(dataDir).paused[sessionKey]?.why ?? null;
}

export function isLockedDown(dataDir: string): boolean {
  return readWatchState(dataDir).lockdown !== null;
}
