import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Tasks Edmund has handed to a Grok Bot and not yet heard back about.
 *
 * `grokbot_task` runs in the turn's own MCP process and `report_to_edmund`
 * arrives in the daemon, so the two meet in a file, not in memory. Append-only
 * JSONL, replayed on every read: two processes appending single short lines
 * never tear each other, and nothing is rewritten under a concurrent writer
 * (apart from the rare compaction, which only drops what has long expired).
 *
 * A reply id is the only thing that lets a Bot call back, so it is validated
 * where it is used: unknown, expired and already-delivered ids each get their
 * own answer.
 */

export const PENDING_TTL_MS = 24 * 60 * 60_000;
/** Compact once the file passes this size; it holds a few hundred bytes a task. */
const COMPACT_BYTES = 512 * 1024;

/**
 * Where a task was asked from: the session Edmund was in when he called
 * `grokbot_task`. The report wakes him there, so a task handed over in a group
 * chat is answered in that group. Absent on tasks recorded before this existed
 * (and on any line that does not parse as one): those wake the owner's DM.
 */
export type PendingOrigin = {
  /** The session key (`imessage:group:<chatGuid>`, `imessage:dm:<handle>`). */
  sessionKey: string;
  /** The chat guid the reply belongs in. For a DM, the guid the tool process
   *  resolved, or "" when it knew none (the relay then uses the DM's own). */
  chatGuid: string;
  isGroup: boolean;
};

/** Reads an origin back from JSON, or null when it is missing or malformed, so a
 *  line from before origins (or a damaged one) can only ever mean "the DM". */
export function parseOrigin(raw: unknown): PendingOrigin | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.sessionKey !== "string" || !o.sessionKey) return null;
  if (typeof o.chatGuid !== "string" || typeof o.isGroup !== "boolean") return null;
  return { sessionKey: o.sessionKey, chatGuid: o.chatGuid, isGroup: o.isGroup };
}

export type PendingTask = {
  replyId: string;
  task: string;
  bot: string;
  /** The session the task was asked from; see PendingOrigin. */
  origin?: PendingOrigin;
  createdMs: number;
  expiresMs: number;
  /** While in the future, Edmund is blocked inside grokbot_task waiting for the
   *  result: a report is handed straight back to that call and wakes no one. */
  waitUntilMs: number;
  /** Set once a result has been delivered. */
  result?: string;
  reportedMs?: number;
  /** The bot whose own connector key the report arrived on; absent when it
   *  came on the shared key. Compared with `bot`, the bot the task was sent
   *  to, it shows a report that came back on another bot's key. */
  reportedBy?: string;
};

type Line =
  | {
      op: "add";
      replyId: string;
      task: string;
      bot: string;
      origin?: PendingOrigin;
      createdMs: number;
      expiresMs: number;
      waitUntilMs: number;
    }
  | { op: "stopwait"; replyId: string; atMs: number }
  | { op: "cancel"; replyId: string; atMs: number }
  | { op: "done"; replyId: string; atMs: number; result: string; by?: string };

export type Lookup =
  | { status: "pending"; task: PendingTask }
  | { status: "reported"; task: PendingTask }
  | { status: "expired"; task: PendingTask }
  | { status: "unknown" };

/** `gb-` and ten hex digits: short enough for a Bot to copy, hard to guess. */
export function newReplyId(): string {
  return `gb-${randomBytes(5).toString("hex")}`;
}

/** Bots mangle ids a little: stray spaces, quotes, upper case. */
export function cleanReplyId(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`.,]+$/g, "")
    .toLowerCase();
}

export class PendingTasks {
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(dataDir, "grok", "pending.jsonl");
  }

  add(task: {
    replyId: string;
    task: string;
    bot: string;
    waitMs?: number;
    origin?: PendingOrigin;
  }): PendingTask {
    const createdMs = this.now();
    const entry: PendingTask = {
      replyId: cleanReplyId(task.replyId),
      task: task.task,
      bot: task.bot,
      ...(task.origin ? { origin: task.origin } : {}),
      createdMs,
      expiresMs: createdMs + PENDING_TTL_MS,
      waitUntilMs: task.waitMs ? createdMs + task.waitMs : 0,
    };
    this.compactIfLarge();
    this.append({ op: "add", ...entry });
    return entry;
  }

  /** What is known about an id right now. */
  lookup(rawId: string): Lookup {
    const replyId = cleanReplyId(rawId);
    const task = this.replay().get(replyId);
    if (!task) return { status: "unknown" };
    if (task.result !== undefined) return { status: "reported", task };
    if (this.now() >= task.expiresMs) return { status: "expired", task };
    return { status: "pending", task };
  }

  /** Record the result. The caller has already checked the id is pending. */
  complete(replyId: string, result: string, by?: string): void {
    this.append({
      op: "done",
      replyId: cleanReplyId(replyId),
      atMs: this.now(),
      result,
      ...(by ? { by } : {}),
    });
  }

  /** The webhook never accepted the task: the id was not handed to any Bot. */
  cancel(replyId: string): void {
    this.append({ op: "cancel", replyId: cleanReplyId(replyId), atMs: this.now() });
  }

  /** The waiting grokbot_task call gave up: a later report must wake Edmund. */
  stopWaiting(replyId: string): void {
    this.append({ op: "stopwait", replyId: cleanReplyId(replyId), atMs: this.now() });
  }

  /** Ids still pending, newest first. */
  open(): PendingTask[] {
    const now = this.now();
    return [...this.replay().values()]
      .filter((t) => t.result === undefined && now < t.expiresMs)
      .sort((a, b) => b.createdMs - a.createdMs);
  }

  private append(line: Line): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  private replay(): Map<string, PendingTask> {
    const tasks = new Map<string, PendingTask>();
    if (!existsSync(this.file)) return tasks;
    for (const raw of readFileSync(this.file, "utf8").split("\n")) {
      if (!raw) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue; // a torn final line from a crash mid-write
      }
      if (line.op === "add") {
        const { origin, ...rest } = line;
        // An origin that does not parse is dropped, not trusted: it routes a wake-up.
        const parsed = parseOrigin(origin);
        tasks.set(line.replyId, { ...rest, ...(parsed ? { origin: parsed } : {}) });
      } else if (line.op === "stopwait") {
        const t = tasks.get(line.replyId);
        if (t) t.waitUntilMs = 0;
      } else if (line.op === "cancel") {
        tasks.delete(line.replyId);
      } else if (line.op === "done") {
        const t = tasks.get(line.replyId);
        if (t && t.result === undefined) {
          t.result = line.result;
          t.reportedMs = line.atMs;
          if (line.by) t.reportedBy = line.by;
        }
      }
    }
    return tasks;
  }

  /** Drop what expired more than a day ago, and everything delivered long since. */
  private compactIfLarge(): void {
    try {
      if (!existsSync(this.file) || statSync(this.file).size < COMPACT_BYTES) return;
      const cutoff = this.now() - PENDING_TTL_MS;
      const keep = [...this.replay().values()].filter((t) => t.expiresMs > cutoff);
      const lines: string[] = [];
      for (const t of keep) {
        lines.push(
          JSON.stringify({
            op: "add",
            replyId: t.replyId,
            task: t.task,
            bot: t.bot,
            ...(t.origin ? { origin: t.origin } : {}),
            createdMs: t.createdMs,
            expiresMs: t.expiresMs,
            waitUntilMs: t.waitUntilMs,
          }),
        );
        if (t.result !== undefined)
          lines.push(
            JSON.stringify({
              op: "done",
              replyId: t.replyId,
              atMs: t.reportedMs ?? t.createdMs,
              result: t.result,
              ...(t.reportedBy ? { by: t.reportedBy } : {}),
            }),
          );
      }
      writeFileSync(this.file, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
    } catch {
      // Compaction is housekeeping; a failed one leaves the log as it was.
    }
  }
}
