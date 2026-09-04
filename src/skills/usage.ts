/**
 * Skill usage log — the record of which skills actually got read, and where.
 *
 * Nothing in the harness recorded this before, which is why the question
 * "does this skill help?" had no answer better than an opinion. It is written
 * from `read_skill`, i.e. from the MCP subprocess, and there can be several of
 * those at once (one per live conversation). So this is an append-only JSONL
 * file, one short line per read, never a read-modify-write of a shared blob:
 * two concurrent turns updating a JSON aggregate would silently lose one of
 * the two counts, and an undercount is exactly the error that would retire a
 * skill people are using.
 *
 * Aggregation happens at read time, in the lifecycle pass, where there is one
 * reader and no race.
 *
 * A read is the honest unit here. It means the model decided this skill was
 * the right thing to load for a live request — which is a real signal, and
 * more than the catalogue had before. It is NOT evidence the skill produced a
 * better answer; nothing in the log can show that. Judging that is what the
 * review pass is for, and it is a judgment, labelled as one.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type UsageEvent = {
  skill: string;
  /** Session that read it. Chat identity, for "used in N different rooms". */
  session: string;
  at_ms: number;
};

export type UsageSummary = {
  reads: number;
  sessions: Set<string>;
  first_ms: number;
  last_ms: number;
};

export function usageLogPath(dataDir: string): string {
  return join(dataDir, "skill-usage.jsonl");
}

/**
 * Record one read. Deliberately swallows every error: a failed write to a
 * telemetry file must never take down the tool call that a person is waiting
 * on. The cost of a lost line is a slightly low count; the cost of a thrown
 * error here is a broken `read_skill`.
 */
export function recordSkillRead(dataDir: string, skill: string, session: string): void {
  try {
    const p = usageLogPath(dataDir);
    mkdirSync(dirname(p), { recursive: true });
    const line = `${JSON.stringify({ skill, session, at_ms: Date.now() } satisfies UsageEvent)}\n`;
    appendFileSync(p, line);
  } catch {
    // Telemetry is never load-bearing.
  }
}

export function readUsageEvents(dataDir: string, sinceMs = 0): UsageEvent[] {
  const p = usageLogPath(dataDir);
  if (!existsSync(p)) return [];
  const out: UsageEvent[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as UsageEvent;
      if (typeof e.skill !== "string" || typeof e.at_ms !== "number") continue;
      if (e.at_ms < sinceMs) continue;
      out.push({ skill: e.skill, session: e.session ?? "", at_ms: e.at_ms });
    } catch {
      // A torn line from a crashed append. Skip it, keep the rest.
    }
  }
  return out;
}

export function summarizeUsage(events: UsageEvent[]): Map<string, UsageSummary> {
  const out = new Map<string, UsageSummary>();
  for (const e of events) {
    const cur = out.get(e.skill);
    if (!cur) {
      out.set(e.skill, {
        reads: 1,
        sessions: new Set([e.session]),
        first_ms: e.at_ms,
        last_ms: e.at_ms,
      });
      continue;
    }
    cur.reads++;
    cur.sessions.add(e.session);
    cur.first_ms = Math.min(cur.first_ms, e.at_ms);
    cur.last_ms = Math.max(cur.last_ms, e.at_ms);
  }
  return out;
}

/**
 * Drop events older than `keepDays`, rewriting the file.
 *
 * Called from the lifecycle pass, which is the one place with a single
 * writer. Retention has to outlive the retirement window by a wide margin —
 * pruning an event that a "has this ever been used?" check still needs would
 * make the log itself the reason a skill gets retired.
 */
export function pruneUsage(dataDir: string, keepDays: number, now = Date.now()): number {
  const p = usageLogPath(dataDir);
  if (!existsSync(p)) return 0;
  const cutoff = now - keepDays * 86_400_000;
  const kept = readUsageEvents(dataDir, cutoff);
  writeFileSync(p, kept.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return kept.length;
}
