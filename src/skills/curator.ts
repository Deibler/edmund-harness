/**
 * The skill curator — a background pass that looks across every conversation
 * at once and asks whether the same job keeps arriving in different rooms.
 *
 * The existing `create_skill` path is per-conversation and reactive: the model
 * notices, mid-turn, that it has done this before *for this person*. In four
 * months of operation it produced exactly one skill. It cannot see the thing
 * this pass exists for — that six different people asked for the same shaped
 * thing, none of them twice, so no single conversation ever felt repetitive.
 *
 * What it mines
 * -------------
 * `recall.sqlite`, not chat.db. The recall index is already keyed by chat and
 * sender, already maintained, and already excludes what the harness could not
 * read. Nothing here has to be kept current by hand — the moment it needs
 * feeding it will stop being fed. Human messages only (`sender != 'me'`):
 * Edmund's own replies describe how he answered, and training the catalogue on
 * his own output would let one bad habit become a documented procedure.
 *
 * The bar
 * -------
 * Most runs must produce nothing, and the caps here are what make that true
 * rather than hoped for:
 *
 *   • a pattern needs >= MIN_OCCURRENCES sightings across >= MIN_CHATS
 *     distinct conversations. Two asks from one person is that person's
 *     private habit, and `create_skill` already covers it.
 *   • at most one new skill per run.
 *   • a hard ceiling on how many curated skills may exist at all. The
 *     catalogue is read by the model to decide what it can do; a hundred
 *     mediocre entries is worse than five good ones.
 *   • per-chat sampling cap. One conversation supplies 29% of all messages
 *     in this deployment, and without a cap every "cross-conversation
 *     pattern" would be that one person's workflow wearing a disguise.
 *
 * What it may write
 * -----------------
 * Instructions only. No scripts, no extra files. These skills are written by
 * a model, from other people's conversations, without anyone reviewing them
 * first, and they become globally readable. That combination earns the
 * narrowest possible blast radius: text a future turn reads, and nothing that
 * executes. The leak scan (privacy.ts) then refuses anything still carrying a
 * name, number or address out of the chats it was distilled from.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { PERSONA_DIR } from "../claude/persona.ts";
import type { Config } from "../config/config.ts";
import { runModelOneShot } from "../model/one-shot.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { recordSpend } from "../spend/ledger.ts";
import { log } from "../util/log.ts";
import { authorSkill } from "./author.ts";
import { type InstallRecord, categoryOf, isValidSkillName, readDb, writeDb } from "./installer.ts";
import { describeLeaks, findLeaks } from "./privacy.ts";

const CURATOR_TIMEOUT_MS = 180_000;

/** Evidence thresholds. A "pattern" that clears neither is a coincidence. */
export const MIN_OCCURRENCES = 3;
export const MIN_CHATS = 2;

/** Sampling. Bounded so one run cannot cost an unbounded amount of context. */
const MAX_SAMPLE_MESSAGES = 400;
const MAX_PER_CHAT = 40;
const MIN_MESSAGE_CHARS = 25;
const MAX_MESSAGE_CHARS = 400;

export type CuratorDeps = {
  config: Config;
  dataDir: string;
  skillsRoot: string;
  dbPath: string;
  contacts: ContactBook;
  /** Injectable so tests never spawn a model. */
  runModel?: typeof runModelOneShot;
  /** Injectable clock, for testing the interval gate. */
  now?: () => number;
};

export type CuratorOutcome =
  | { ran: false; reason: string }
  | { ran: true; created: string | null; considered: number; rejected: string[] };

/** One human message, flattened for the prompt. */
export type SampledAsk = { ref: string; chat: string; text: string; ts: number };

/**
 * Pull a diverse sample of what people actually asked for.
 *
 * Round-robins across chats instead of taking the newest N overall, so a
 * single busy conversation cannot crowd every other room out of the sample.
 * That is the difference between "a pattern across conversations" and
 * "whatever the loudest chat did this week".
 */
export function sampleRecentAsks(
  recallDbPath: string,
  opts: { sinceMs: number; now?: number },
): SampledAsk[] {
  const db = new Database(recallDbPath, { readonly: true });
  try {
    const rows = db
      .query<{ ref: string; chat_guid: string | null; text: string; ts: number }, [number]>(
        `SELECT ref, chat_guid, text, ts
           FROM rows
          WHERE kind = 'message'
            AND sender IS NOT NULL AND sender != 'me'
            AND ts >= ?
          ORDER BY ts DESC`,
      )
      .all(opts.sinceMs);

    const byChat = new Map<string, SampledAsk[]>();
    for (const r of rows) {
      const text = stripIndexPrefix(r.text);
      if (text.length < MIN_MESSAGE_CHARS) continue;
      const chat = r.chat_guid ?? "(unknown)";
      const bucket = byChat.get(chat) ?? [];
      if (bucket.length >= MAX_PER_CHAT) continue;
      bucket.push({ ref: r.ref, chat, text: text.slice(0, MAX_MESSAGE_CHARS), ts: r.ts });
      byChat.set(chat, bucket);
    }

    // Round-robin so the sample is wide before it is deep.
    const out: SampledAsk[] = [];
    const buckets = [...byChat.values()];
    for (let i = 0; out.length < MAX_SAMPLE_MESSAGES; i++) {
      let progressed = false;
      for (const b of buckets) {
        const item = b[i];
        if (!item) continue;
        out.push(item);
        progressed = true;
        if (out.length >= MAX_SAMPLE_MESSAGES) break;
      }
      if (!progressed) break;
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * The indexer stores a display-prefixed line ("[2026-08-29] +1555…: text").
 * The prefix is the sender's handle, which is exactly the personal detail the
 * curator must never see — strip it before the text reaches the prompt rather
 * than relying on the leak scan to catch it on the way out.
 */
function stripIndexPrefix(text: string): string {
  return text.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*[^:]{0,64}:\s*/, "").trim();
}

export const CURATOR_PROMPT = `You are the skill curator for a personal assistant that talks to many
different people in separate conversations.

You are shown a sample of things people ASKED FOR, drawn from many different
chats. Chats are identified by an opaque id only. Your job is to find a
recurring JOB — the same shaped request arriving from unrelated people — and
write a skill that makes the assistant better at that job next time.

WHAT COUNTS AS A PATTERN
  • The same underlying task, asked by people who do not know each other.
  • At least ${MIN_OCCURRENCES} separate occurrences, spanning at least ${MIN_CHATS} different chats.
  • The repetition must be in the TASK, not the topic. Four people mentioning
    the weather is not a pattern. Four people asking "should I leave now given
    the radar" is a pattern: it has a procedure.

WHAT DOES NOT COUNT
  • One person asking repeatedly. That is their habit, and a per-chat skill
    already handles it.
  • Anything an existing skill already covers (the catalogue is below).
  • A topic with no procedure. If you cannot write down steps that would make
    the next answer better, there is no skill here — only a subject.
  • Anything that needs someone's personal details to be useful.

REPORTING NOTHING IS THE NORMAL OUTCOME.
Most weeks contain no new pattern. An unnecessary skill is worse than a
missing one: it is read, believed, and followed. If nothing clears the bar,
return {"skills": []} and say why in "notes". Do not stretch to fill the slot.

THE SKILL YOU WRITE
Write it for a stranger who will follow it cold, with no memory of the
conversations it came from. It must contain NO names, phone numbers, email
addresses, street addresses, or details identifying anyone. Write the
procedure, not the anecdote. Instructions only — no scripts, no extra files.

OUTPUT — raw JSON, no prose, no code fence:
{
  "skills": [
    {
      "name": "kebab-case-name",
      "description": "one line: what it does and when to reach for it",
      "instructions": "the full SKILL.md body — the steps, the tools, the format, the gotchas",
      "evidence": [
        {"ref": "msg:...", "chat": "chat id", "reading": "what this ask was really after"}
      ],
      "why_now": "why this is a durable job and not a coincidence"
    }
  ],
  "notes": "one line on what you considered and rejected"
}

Return at most ONE skill. Cite real refs from the sample — an entry whose
evidence does not span ${MIN_CHATS} distinct chats will be discarded.`;

type ProposedSkill = {
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  evidence?: unknown;
  why_now?: unknown;
};

export type Proposal = {
  name: string;
  description: string;
  instructions: string;
  evidence: { ref: string; chat: string; reading: string }[];
  whyNow: string;
};

/** Parse the model's JSON, tolerating a fenced block. Returns [] on garbage. */
export function parseProposals(raw: string | null): { proposals: Proposal[]; notes: string } {
  if (!raw) return { proposals: [], notes: "" };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { proposals: [], notes: "" };
  let parsed: { skills?: unknown; notes?: unknown };
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { proposals: [], notes: "" };
  }
  const list = Array.isArray(parsed.skills) ? parsed.skills : [];
  const proposals: Proposal[] = [];
  for (const item of list as ProposedSkill[]) {
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const description = typeof item.description === "string" ? item.description.trim() : "";
    const instructions = typeof item.instructions === "string" ? item.instructions.trim() : "";
    if (!name || !description || !instructions) continue;
    const evidence: Proposal["evidence"] = [];
    if (Array.isArray(item.evidence)) {
      for (const e of item.evidence as Record<string, unknown>[]) {
        const ref = typeof e?.ref === "string" ? e.ref : "";
        const chat = typeof e?.chat === "string" ? e.chat : "";
        if (!ref || !chat) continue;
        evidence.push({
          ref,
          chat,
          reading: typeof e?.reading === "string" ? e.reading : "",
        });
      }
    }
    proposals.push({
      name,
      description,
      instructions,
      evidence,
      whyNow: typeof item.why_now === "string" ? item.why_now : "",
    });
  }
  return { proposals, notes: typeof parsed.notes === "string" ? parsed.notes : "" };
}

export type VetOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Everything that must be true before a proposal becomes a skill.
 *
 * Kept separate from the run loop and exported, so the bar can be tested
 * directly with no model, no clock, and no filesystem — and so a future
 * change to the bar has somewhere obvious to go.
 */
export function vetProposal(args: {
  proposal: Proposal;
  sample: SampledAsk[];
  existing: Record<string, InstallRecord>;
  existingNames: string[];
  /** Names already retired. A retirement that can be undone by the next
   *  pass writing the same skill again is not a retirement. */
  retiredNames?: string[];
  contacts: ContactBook;
  /** The assistant's own names — allowed to appear in its own skills. */
  selfNames?: string[];
}): VetOutcome {
  const { proposal, sample, existingNames, contacts } = args;

  if (!isValidSkillName(proposal.name)) {
    return { ok: false, reason: `invalid name "${proposal.name}"` };
  }
  if (existingNames.includes(proposal.name)) {
    return { ok: false, reason: `"${proposal.name}" already exists` };
  }
  if (args.retiredNames?.includes(proposal.name)) {
    return { ok: false, reason: `"${proposal.name}" was retired before — not writing it again` };
  }

  // Evidence must be real. A model asked for citations will supply citations;
  // the question is whether they point at anything. Refs are checked against
  // the sample it was actually shown, so an invented ref cannot vouch for an
  // invented pattern.
  const sampleRefs = new Map(sample.map((s) => [s.ref, s.chat]));
  const chats = new Set<string>();
  let realRefs = 0;
  for (const e of proposal.evidence) {
    const chat = sampleRefs.get(e.ref);
    if (!chat) continue;
    realRefs++;
    chats.add(chat);
  }
  if (realRefs < MIN_OCCURRENCES) {
    return {
      ok: false,
      reason: `only ${realRefs} of ${proposal.evidence.length} cited refs exist in the sample (need ${MIN_OCCURRENCES})`,
    };
  }
  if (chats.size < MIN_CHATS) {
    return {
      ok: false,
      reason: `evidence spans ${chats.size} chat(s), need ${MIN_CHATS} — this is one person's habit`,
    };
  }

  const text = `${proposal.name}\n${proposal.description}\n${proposal.instructions}`;
  const leaks = findLeaks(text, contacts, args.selfNames ?? [], {
    personaDir: PERSONA_DIR,
  });
  if (leaks.length > 0) {
    return { ok: false, reason: `carries personal detail: ${describeLeaks(leaks)}` };
  }

  return { ok: true };
}

/** How many curated skills exist right now. */
export function curatedCount(db: Record<string, InstallRecord>): number {
  return Object.values(db).filter((r) => categoryOf(r) === "curated").length;
}

/**
 * One curator pass. Returns what happened rather than throwing — this is
 * enrichment, and a curator that can break a daemon is not worth having.
 */
export async function runCurator(deps: CuratorDeps): Promise<CuratorOutcome> {
  const cfg = deps.config.skill_curator;
  const now = deps.now ?? Date.now;
  if (!cfg.enabled) return { ran: false, reason: "disabled" };

  const db = readDb(deps.dbPath);
  if (curatedCount(db.skills) >= cfg.max_curated_skills) {
    return { ran: false, reason: `at the ceiling of ${cfg.max_curated_skills} curated skills` };
  }

  const recallPath = join(deps.dataDir, "recall.sqlite");
  const sinceMs = now() - cfg.lookback_days * 86_400_000;
  let sample: SampledAsk[];
  try {
    sample = sampleRecentAsks(recallPath, { sinceMs });
  } catch (err) {
    return { ran: false, reason: `could not read the recall index: ${(err as Error).message}` };
  }

  const distinctChats = new Set(sample.map((s) => s.chat)).size;
  if (distinctChats < MIN_CHATS) {
    return {
      ran: false,
      reason: `only ${distinctChats} chat(s) in the window — nothing to compare`,
    };
  }

  const catalogue = Object.entries(db.skills)
    .map(([name, r]) => `  • ${name} — ${r.source}`)
    .join("\n");
  // Retired skills are shown so the curator does not rediscover the same
  // pattern it already got wrong. It mines the same corpus every pass, so
  // without this a bad idea recurs forever.
  const graveyard = Object.values(db.retired ?? {})
    .map((r) => `  • ${r.name} — ${r.description || "(no description)"} [retired: ${r.reason}]`)
    .join("\n");

  const userPrompt = [
    "EXISTING SKILL CATALOGUE (do not duplicate any of these):",
    catalogue || "  (none)",
    "",
    "ALREADY TRIED AND RETIRED — do not propose these again, or a variation:",
    graveyard || "  (none)",
    "",
    `SAMPLE — ${sample.length} asks across ${distinctChats} chats, last ${cfg.lookback_days} days:`,
    ...sample.map((s) => `[${s.ref}] (chat ${s.chat.slice(0, 12)}) ${s.text}`),
  ].join("\n");

  const run = deps.runModel ?? runModelOneShot;
  const started = now();
  const r = await run({
    args: [
      "--model",
      cfg.model,
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      CURATOR_PROMPT,
    ],
    input: userPrompt,
    timeoutMs: CURATOR_TIMEOUT_MS,
  });
  recordSpend(deps.dataDir, {
    sessionKey: "curator",
    subsystem: "skill-curator",
    model: r.model ?? cfg.model,
    costUsd: r.costUsd,
    durMs: r.durationMs,
  });
  if (!r.ok) {
    return { ran: false, reason: `model call failed: ${r.error ?? "unknown"}` };
  }

  const { proposals, notes } = parseProposals(r.text);
  const rejected: string[] = [];
  const existingNames = Object.keys(db.skills);

  for (const proposal of proposals) {
    const vet = vetProposal({
      proposal,
      sample,
      existing: db.skills,
      existingNames,
      retiredNames: Object.keys(db.retired ?? {}),
      contacts: deps.contacts,
      selfNames: deps.config.identity.names,
    });
    if (!vet.ok) {
      rejected.push(`${proposal.name}: ${vet.reason}`);
      continue;
    }

    const authored = authorSkill({
      name: proposal.name,
      description: proposal.description,
      instructions: proposal.instructions,
      // Instructions only — see the header. A curated skill never ships code.
      extraFiles: [],
      scope: null,
      originScope: null,
      opts: {
        skillsRoot: deps.skillsRoot,
        dbPath: deps.dbPath,
        requireApprovalForScripts: deps.config.skills_marketplace.require_approval_for_scripts,
      },
    });
    if (!authored.ok) {
      rejected.push(`${proposal.name}: ${authored.reason}`);
      continue;
    }

    // Re-read: authorSkill wrote the record, and stamping curated provenance
    // on a stale copy would drop it.
    const after = readDb(deps.dbPath);
    const record = after.skills[proposal.name];
    if (record) {
      record.category = "curated";
      record.source = "curated";
      record.scope = null;
      record.origin_scope = null;
      record.provenance = [
        `why: ${proposal.whyNow}`,
        ...proposal.evidence.map((e) => `${e.ref} (chat ${e.chat.slice(0, 12)}) — ${e.reading}`),
      ];
      writeDb(deps.dbPath, after);
    }

    log.info("skill-curator", "wrote a curated skill", {
      name: proposal.name,
      evidence: proposal.evidence.length,
      sample: sample.length,
      chats: distinctChats,
      cost_usd: r.costUsd ?? 0,
      dur_ms: now() - started,
    });
    return { ran: true, created: proposal.name, considered: sample.length, rejected };
  }

  log.info("skill-curator", "no new skill this run", {
    sample: sample.length,
    chats: distinctChats,
    proposals: proposals.length,
    rejected: rejected.length,
    notes: notes.slice(0, 160),
    cost_usd: r.costUsd ?? 0,
  });
  return { ran: true, created: null, considered: sample.length, rejected };
}
