import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reading Codex's own session rollout for the one number its exec stream
 * does not expose: the thread's live context.
 *
 * `turn.completed` usage is cumulative over the thread's whole life — a
 * long-lived thread reported `in=9M` while its actual per-request context
 * was 200k (read from this file, 2026-08-11). Every request Codex makes is
 * recorded in the rollout as a `token_count` event whose
 * `last_token_usage.input_tokens` IS the live context, so the harness reads
 * the last one instead of guessing from cumulative totals. The auto-compact
 * threshold is the only consumer, and it needs "context", not "spend".
 *
 * The rollout lives under CODEX_HOME (default ~/.codex) regardless of
 * `--ignore-user-config`, at sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl,
 * dated by the thread's creation day.
 */

/** How much of the file tail to scan for the last token_count. Requests are
 *  logged frequently, so the final one is never far from the end; the margin
 *  covers a long final assistant message written after it. */
const TAIL_BYTES = 256 * 1024;

/** How many day-directories to walk, newest first, before giving up. A
 *  thread older than this has long since been re-anchored or evicted. */
const MAX_DAY_DIRS = 90;

function codexSessionsDir(): string {
  const home = process.env.CODEX_HOME?.trim();
  return join(home?.length ? home : join(homedir(), ".codex"), "sessions");
}

function sortedDesc(entries: string[]): string[] {
  return entries.filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a));
}

/** The rollout file for a thread id, searching newest day-directories first. */
export function rolloutPathForThread(
  threadId: string,
  root: string = codexSessionsDir(),
): string | null {
  if (!threadId) return null;
  const suffix = `-${threadId}.jsonl`;
  let scanned = 0;
  let years: string[];
  try {
    years = sortedDesc(readdirSync(root));
  } catch {
    return null;
  }
  for (const year of years) {
    for (const month of sortedDesc(safeReaddir(join(root, year)))) {
      for (const day of sortedDesc(safeReaddir(join(root, year, month)))) {
        if (scanned++ >= MAX_DAY_DIRS) return null;
        const dir = join(root, year, month, day);
        for (const file of safeReaddir(dir)) {
          if (file.endsWith(suffix)) return join(dir, file);
        }
      }
    }
  }
  return null;
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Last `token_count` event's live-context reading, from the file's tail. */
export function liveContextFromRollout(path: string): number | null {
  let tail: string;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      tail = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    // The first line of the tail may be a truncated JSON row; parse failures
    // just skip it.
    if (!line.startsWith("{")) continue;
    try {
      const row = JSON.parse(line) as {
        payload?: { type?: string; info?: { last_token_usage?: { input_tokens?: number } } };
      };
      if (row.payload?.type !== "token_count") continue;
      const live = row.payload.info?.last_token_usage?.input_tokens;
      if (typeof live === "number" && live >= 0) return live;
    } catch {
      // Truncated or foreign line — keep walking up.
    }
  }
  return null;
}

/** The thread's live context in tokens, or null when the rollout is missing
 *  or unreadable (ephemeral run, format drift, foreign CODEX_HOME). */
export function liveContextForThread(threadId: string, root?: string): number | null {
  const path = rolloutPathForThread(threadId, root);
  return path ? liveContextFromRollout(path) : null;
}
