/**
 * Lifecycle for curated skills — retire the ones nobody reaches for, and put
 * the ones people DO reach for in front of a reviewer.
 *
 * A curator that only ever adds is a ratchet. Every pass makes the catalogue
 * longer, the model reads the whole catalogue to decide what it can do, and
 * the good entries get harder to find among the plausible ones. Writing is
 * the easy half; the half that keeps the catalogue worth reading is being
 * willing to delete.
 *
 * Two passes, deliberately asking different questions:
 *
 *   RETIREMENT — mechanical. "Has this ever been read?" The usage log
 *   answers it with a fact, so no model is involved and no judgment is
 *   needed. A curated skill that has sat unread past the grace period was a
 *   pattern the curator imagined.
 *
 *   REVIEW — judgment, and labelled as such. A skill that IS read gets shown
 *   to a reviewer alongside the actual asks from the conversations where it
 *   was read, and the question is whether it addressed the gap or just
 *   happened to be nearby. Nothing in the usage log can answer that: a read
 *   means the model chose to load it, not that the answer got better. So the
 *   verdict is an opinion with the evidence attached, and it is recorded that
 *   way rather than dressed up as a measurement.
 *
 * Only CURATED skills are subject to either. A skill a person wrote or
 * published is theirs; unused is not a defect in something someone chose to
 * keep, and this pass has no standing to delete it.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config/config.ts";
import { runModelOneShot } from "../model/one-shot.ts";
import { log } from "../util/log.ts";
import { revokeConsentFor } from "./consent.ts";
import { type InstallRecord, categoryOf, readDb, uninstallSkill, writeDb } from "./installer.ts";
import { type UsageSummary, pruneUsage, readUsageEvents, summarizeUsage } from "./usage.ts";

const REVIEW_TIMEOUT_MS = 120_000;

export type LifecycleDeps = {
  config: Config;
  dataDir: string;
  skillsRoot: string;
  dbPath: string;
  consentDbPath: string;
  runModel?: typeof runModelOneShot;
  now?: () => number;
};

export type LifecycleOutcome = {
  retired: { name: string; reason: string }[];
  reviewed: { name: string; verdict: Verdict; reason: string }[];
};

export type Verdict = "keep" | "revise" | "retire";

/**
 * How far back the usage log must be readable for a retirement decision to
 * be sound.
 *
 * This is the trap the whole pass turns on. If usage retention is shorter
 * than the grace period, a skill read once on day one looks unread on day
 * forty, and the pass retires the skills that are working. Retention is
 * therefore derived from the grace period rather than configured beside it —
 * two independent numbers that must satisfy an inequality is a bug waiting
 * for someone to tune one of them.
 */
export function usageRetentionDays(graceDays: number): number {
  return Math.max(90, graceDays * 3);
}

/**
 * Retire curated skills nobody has read.
 *
 * `installed_at` must be older than the grace period — a skill written
 * yesterday has not had a chance yet, and retiring it would just mean the
 * curator writes it again next pass.
 */
export function retireUnusedCurated(deps: LifecycleDeps): { name: string; reason: string }[] {
  const cfg = deps.config.skill_curator;
  const now = (deps.now ?? Date.now)();
  const graceMs = cfg.retire_unused_after_days * 86_400_000;

  const events = readUsageEvents(
    deps.dataDir,
    now - usageRetentionDays(cfg.retire_unused_after_days) * 86_400_000,
  );
  const usage = summarizeUsage(events);

  const db = readDb(deps.dbPath);
  const retired: { name: string; reason: string }[] = [];

  for (const [name, record] of Object.entries(db.skills)) {
    if (categoryOf(record) !== "curated") continue;
    const age = now - record.installed_at;
    if (age < graceMs) continue;
    if ((usage.get(name)?.reads ?? 0) > 0) continue;

    const days = Math.round(age / 86_400_000);
    const reason = `never read in ${days} days`;
    const description = skillDescription(deps.skillsRoot, name);
    const result = uninstallSkill(name, {
      skillsRoot: deps.skillsRoot,
      dbPath: deps.dbPath,
      requireApprovalForScripts: deps.config.skills_marketplace.require_approval_for_scripts,
    });
    if (!result.uninstalled) {
      log.warn("skill-curator", "could not retire an unused skill", { name, err: result.reason });
      continue;
    }
    tombstone(deps.dbPath, name, description, reason, 0);
    revokeConsentFor(name, deps.consentDbPath);
    retired.push({ name, reason });
    log.info("skill-curator", "retired an unused curated skill", { name, reason });
  }
  return retired;
}

/**
 * Record why a skill went, so the curator does not write it again.
 *
 * `description` is passed in rather than looked up: uninstall moves the skill
 * directory to .trash, so by the time this runs the SKILL.md is gone from
 * where a lookup would search. Read it first, retire second.
 */
function tombstone(
  dbPath: string,
  name: string,
  description: string,
  reason: string,
  reads: number,
): void {
  const db = readDb(dbPath);
  db.retired = db.retired ?? {};
  db.retired[name] = {
    name,
    description,
    reason,
    retired_at: Date.now(),
    reads,
  };
  writeDb(dbPath, db);
}

/** The catalogue line for a skill, read from disk while it is still there. */
export function skillDescription(skillsRoot: string, name: string): string {
  const p = resolve(skillsRoot, name, "SKILL.md");
  if (!existsSync(p)) return "";
  const fm = readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---/);
  const line = fm?.[1]?.split("\n").find((l) => l.trim().toLowerCase().startsWith("description:"));
  return line
    ? line
        .replace(/^[^:]*:\s*/, "")
        .trim()
        .replace(/^["']|["']$/g, "")
    : "";
}

export const REVIEW_PROMPT = `You are reviewing a skill that an automated curator wrote for a personal
assistant. The curator believed several unrelated people kept asking for the
same job, and wrote this skill so the assistant would handle it better.

You are shown: the skill, how often it has been read, and the ACTUAL messages
from the conversations where it was read.

The question is narrow and you should resist widening it:

    Did this skill address the gap it claims to address?

Read the real asks. Then decide:

  "keep"   — the asks match what the skill is for, and the instructions would
             genuinely have made the answer better. The default when the skill
             is doing its job, even unglamorously.

  "revise" — the job is real and recurring, but the instructions are wrong,
             vague, or aimed slightly off what people are actually asking. Say
             what is wrong and supply a full replacement body.

  "retire" — the skill does not correspond to a real recurring job. The reads
             were incidental: it was loaded because its name looked relevant,
             not because it helped. Also retire if the "procedure" is generic
             advice the assistant would have given anyway — a skill that
             restates common sense costs catalogue space and teaches nothing.

Be willing to retire. This catalogue is read in full by the assistant to
decide what it can do, so a skill that is merely harmless is still a cost.
Do not keep something because deleting it feels wasteful.

OUTPUT — raw JSON, no prose, no code fence:
{
  "verdict": "keep" | "revise" | "retire",
  "reason": "one or two sentences, citing what you saw in the real asks",
  "instructions": "full replacement SKILL.md body — required for revise, omit otherwise"
}`;

/**
 * Put every used curated skill that is due in front of the reviewer.
 *
 * Due = read at least `review_after_reads` times and not reviewed within
 * `review_interval_days`. Both bounds matter: reviewing on every pass would
 * spend a model call per skill per day to re-confirm what it said yesterday.
 */
export async function reviewUsedCurated(
  deps: LifecycleDeps,
): Promise<{ name: string; verdict: Verdict; reason: string }[]> {
  const cfg = deps.config.skill_curator;
  const now = (deps.now ?? Date.now)();
  const events = readUsageEvents(
    deps.dataDir,
    now - usageRetentionDays(cfg.retire_unused_after_days) * 86_400_000,
  );
  const usage = summarizeUsage(events);

  const db = readDb(deps.dbPath);
  const out: { name: string; verdict: Verdict; reason: string }[] = [];

  for (const [name, record] of Object.entries(db.skills)) {
    if (categoryOf(record) !== "curated") continue;
    const stats = usage.get(name);
    if (!stats || stats.reads < cfg.review_after_reads) continue;
    const since = now - (record.last_reviewed_ms ?? 0);
    if (since < cfg.review_interval_days * 86_400_000) continue;

    const verdict = await reviewOne(name, record, stats, events, deps);
    if (verdict) out.push({ name, verdict: verdict.verdict, reason: verdict.reason });
  }
  return out;
}

async function reviewOne(
  name: string,
  record: InstallRecord,
  stats: UsageSummary,
  events: ReturnType<typeof readUsageEvents>,
  deps: LifecycleDeps,
): Promise<{ verdict: Verdict; reason: string } | null> {
  const skillPath = resolve(deps.skillsRoot, name, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  const body = readFileSync(skillPath, "utf8");

  const reads = events.filter((e) => e.skill === name);
  const context = asksAroundReads(deps.dataDir, reads);
  if (context.length === 0) {
    // No recoverable evidence means no basis for a verdict. Saying "keep"
    // here would launder an absence of information into an endorsement.
    log.info("skill-curator", "skipping review — no recoverable context", { name });
    return null;
  }

  const userPrompt = [
    "THE SKILL:",
    body,
    "",
    `USAGE: read ${stats.reads} times across ${stats.sessions.size} conversation(s).`,
    "",
    "WHAT PEOPLE WERE ACTUALLY ASKING, in the conversations where it was read:",
    ...context.map((c) => `  • ${c}`),
  ].join("\n");

  const run = deps.runModel ?? runModelOneShot;
  const r = await run({
    args: [
      "--model",
      deps.config.skill_curator.model,
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      REVIEW_PROMPT,
    ],
    input: userPrompt,
    timeoutMs: REVIEW_TIMEOUT_MS,
  });
  if (!r.ok || !r.text) return null;

  const parsed = parseVerdict(r.text);
  if (!parsed) return null;

  const db = readDb(deps.dbPath);
  const live = db.skills[name];
  if (!live) return null;
  live.last_reviewed_ms = (deps.now ?? Date.now)();
  writeDb(deps.dbPath, db);

  if (parsed.verdict === "retire") {
    const description = skillDescription(deps.skillsRoot, name);
    const result = uninstallSkill(name, {
      skillsRoot: deps.skillsRoot,
      dbPath: deps.dbPath,
      requireApprovalForScripts: deps.config.skills_marketplace.require_approval_for_scripts,
    });
    if (result.uninstalled) {
      tombstone(deps.dbPath, name, description, `review: ${parsed.reason}`, stats.reads);
      revokeConsentFor(name, deps.consentDbPath);
      log.info("skill-curator", "retired a curated skill on review", {
        name,
        reason: parsed.reason,
      });
    }
  } else if (parsed.verdict === "revise" && parsed.instructions) {
    const { updateAuthoredSkill } = await import("./author.ts");
    const updated = updateAuthoredSkill({
      name,
      instructions: parsed.instructions,
      extraFiles: [],
      // A curated skill has no owning chat, so ownership cannot block this.
      sessionKey: record.origin_scope ?? "",
      opts: {
        skillsRoot: deps.skillsRoot,
        dbPath: deps.dbPath,
        requireApprovalForScripts: deps.config.skills_marketplace.require_approval_for_scripts,
      },
    });
    if (!updated.ok) {
      log.warn("skill-curator", "revision rejected", { name, err: updated.reason });
    } else {
      log.info("skill-curator", "revised a curated skill", { name, reason: parsed.reason });
    }
  } else {
    log.info("skill-curator", "kept a curated skill", { name, reason: parsed.reason });
  }

  return { verdict: parsed.verdict, reason: parsed.reason };
}

export function parseVerdict(
  raw: string,
): { verdict: Verdict; reason: string; instructions?: string } | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const p = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    const v = p.verdict;
    if (v !== "keep" && v !== "revise" && v !== "retire") return null;
    return {
      verdict: v,
      reason: typeof p.reason === "string" ? p.reason : "",
      instructions: typeof p.instructions === "string" ? p.instructions : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * The human messages sitting near each read, from the chat where it happened.
 *
 * This is the evidence the reviewer needs and the only part that is not
 * cheap: it joins the usage log (session keys) to state.db (session → chat)
 * to recall (messages in that chat around that time). Best-effort — a missing
 * db yields no context, and no context means no verdict rather than a
 * confident one.
 */
function asksAroundReads(dataDir: string, reads: { session: string; at_ms: number }[]): string[] {
  const statePath = join(dataDir, "state.db");
  const recallPath = join(dataDir, "recall.sqlite");
  if (!existsSync(statePath) || !existsSync(recallPath)) return [];

  const out: string[] = [];
  let state: Database | null = null;
  let recall: Database | null = null;
  try {
    state = new Database(statePath, { readonly: true });
    recall = new Database(recallPath, { readonly: true });
    const chatFor = state.query<{ chat_guid: string }, [string]>(
      "SELECT chat_guid FROM sessions WHERE session_key = ? LIMIT 1",
    );
    const asks = recall.query<{ text: string }, [string, number, number]>(
      `SELECT text FROM rows
        WHERE kind = 'message' AND chat_guid = ?
          AND sender IS NOT NULL AND sender != 'me'
          AND ts BETWEEN ? AND ?
        ORDER BY ts DESC LIMIT 4`,
    );

    const seen = new Set<string>();
    for (const read of reads.slice(-12)) {
      const chat = chatFor.get(read.session)?.chat_guid;
      if (!chat) continue;
      // A 30-minute window before the read: the request that made the model
      // reach for the skill, not whatever came after it answered.
      for (const row of asks.all(chat, read.at_ms - 30 * 60_000, read.at_ms)) {
        const text = row.text.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*[^:]{0,64}:\s*/, "").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text.slice(0, 300));
      }
    }
  } catch {
    return out;
  } finally {
    state?.close();
    recall?.close();
  }
  return out.slice(0, 40);
}

/**
 * Both passes, for the scheduler and the CLI.
 *
 * Pruning happens LAST and only here: this is the one place with a single
 * writer, and pruning before the passes would delete the evidence they are
 * about to read.
 */
export async function runLifecycle(deps: LifecycleDeps): Promise<LifecycleOutcome> {
  const retired = retireUnusedCurated(deps);
  const reviewed = await reviewUsedCurated(deps);
  pruneUsage(deps.dataDir, usageRetentionDays(deps.config.skill_curator.retire_unused_after_days));
  return { retired, reviewed };
}
