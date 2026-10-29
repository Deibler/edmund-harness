#!/usr/bin/env bun
/**
 * Replay auto-recall over hand-labelled questions from a real conversation and
 * report how often the message a reply needed actually reached the model.
 * Run it before and after any change to recall: a ranking or boundary change
 * is kept only if this number holds or rises.
 *
 *   bun scripts/recall-eval.ts [--needles data/evals/recall-needles.jsonl]
 *       [--compactions data/evals/compactions.txt] [--boundary fixed|compaction]
 *       [--contextualize] [--label name]
 *
 * Needles are JSON lines (gitignored, they hold real messages):
 *   {"id", "query_ms", "query_text", "chat_guid", "needle_guids": [...],
 *    "gap_hours", "topic"}                       a question and its answer
 *   {"id", "query_ms", "query_text", "chat_guid", "kind": "ack"}
 *                                               a message with nothing to find
 * A needle counts as reached when any of its `msg:<guid>` rows is in the
 * recent or deep block the model would have been shown. Acks measure noise:
 * the hits a subject-less message pulls in.
 *
 * Compactions are the moments the conversation was summarised, one
 * "<ISO time> <auto|manual>" per line, read from the transcript's
 * compact_boundary rows, the system of record. `--boundary fixed` recalls the
 * way production did before 2026-10-29 (skip a fixed recent window, and only
 * manual compactions were known); `compaction` treats everything older than
 * the last compaction as out of the model's sight.
 *
 * Each question is replayed as of its own moment (`nowMs`) against the live
 * index, so rows written later are ignored by the time filters. The one
 * thing not replayed is the per-session "already surfaced" set, so a hit
 * here can be one production would have suppressed as a repeat.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recallSightSince } from "../src/boot/wire-recall.ts";
import { loadConfig } from "../src/config/config.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { RECALL_KINDS, autoRecall } from "../src/memory/auto-recall.ts";
import { embedQuery, makeProvider } from "../src/memory/embed-provider.ts";
import { VectorStore, normalize } from "../src/memory/vector-store.ts";
import { AddressBook } from "../src/sessions/address-book.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import { LearnedNames } from "../src/sessions/learned-names.ts";

type Needle = {
  id: string;
  query_ms: number;
  query_text: string;
  chat_guid: string;
  needle_guids?: string[];
  gap_hours?: number;
  topic?: string;
  kind?: "needle" | "ack";
  /** Edmund's last message before the question, for --contextualize. */
  last_outbound_text?: string;
};

type Compaction = { atMs: number; trigger: "auto" | "manual" };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const config = loadConfig();
const dataDir = config.paths.data_dir;
const needlesPath = arg("needles", join(dataDir, "evals/recall-needles.jsonl"));
const compactionsPath = arg("compactions", join(dataDir, "evals/compactions.txt"));
const boundary = arg("boundary", "compaction") as "fixed" | "compaction";
const contextualize = process.argv.includes("--contextualize");
const label = arg("label", `${boundary}${contextualize ? "+ctx" : ""}`);

/** --contextualize: a short follow-up ("yeah do brown instead") is searched
 *  together with the message it answers. */
function queryFor(n: Needle): string {
  if (!contextualize || !n.last_outbound_text) return n.query_text;
  if (n.query_text.trim().split(/\s+/).length >= 12) return n.query_text;
  return `${n.last_outbound_text.slice(0, 500)}\n${n.query_text}`;
}

const needles: Needle[] = readFileSync(needlesPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const compactions: Compaction[] = existsSync(compactionsPath)
  ? readFileSync(compactionsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        const [iso, trigger] = l.trim().split(/\s+/);
        return {
          atMs: Date.parse(iso!),
          trigger: trigger === "manual" ? "manual" : "auto",
        } as Compaction;
      })
      .sort((a, b) => a.atMs - b.atMs)
  : [];

/** The newest compaction before `ms`, optionally only those the harness saw. */
function lastCompactBefore(ms: number, manualOnly: boolean): number {
  let last = 0;
  for (const c of compactions) {
    if (c.atMs >= ms) break;
    if (!manualOnly || c.trigger === "manual") last = c.atMs;
  }
  return last;
}

const mr = config.memory_recall;
const chatDb = new ChatDb(config.paths.chat_db);
const contacts = new ContactBook(config.contacts, new AddressBook(), new LearnedNames(dataDir));
const threadDeps = { config, chatDb, contacts, state: null };
const store = new VectorStore(join(dataDir, mr.index_db));
const provider = makeProvider({
  provider: mr.provider,
  model: mr.model,
  dim: mr.dim,
  ollamaEndpoint: mr.ollama_endpoint,
  openaiKey: config.keys.openai,
});

type Outcome = {
  id: string;
  kind: "needle" | "ack";
  topic?: string;
  gapHours?: number;
  reached: boolean;
  block: "recent" | "deep" | null;
  position: number | null;
  shown: number;
  blind: boolean;
  /** The needle is in the model's verbatim sight without recall: after the
   *  last compaction, or (with the hook) in the thread it re-injected. */
  inSight: boolean;
  missReason?: "not-indexed" | "window" | "below-floor" | "ranked-out";
  needleCosine?: number;
};

const outcomes: Outcome[] = [];
for (const n of needles) {
  const kind = n.kind ?? "needle";
  const lastAll = lastCompactBefore(n.query_ms, false);
  // Production before this change only ever learned of its own /compact.
  const lastKnown = boundary === "fixed" ? lastCompactBefore(n.query_ms, true) : lastAll;
  const windowMs = mr.auto_recall_window_hours * 3_600_000;
  // The same edge production computes: where the thread the hook re-injected
  // after the last compaction begins.
  const excludeFromMs =
    boundary === "compaction"
      ? recallSightSince(
          `imessage:dm:${n.chat_guid.split(";").pop()}` as never,
          n.chat_guid,
          lastAll,
          threadDeps,
        )
      : undefined;
  const query = queryFor(n);
  const result = await autoRecall(query, provider, store, {
    chatGuid: n.chat_guid,
    limit: mr.auto_recall_limit,
    minScore: mr.auto_recall_min_score,
    selfNames: config.identity.names,
    excludeRecentMs: windowMs,
    excludeFromMs,
    deepSplitDays: mr.auto_recall_deep_split_days,
    deepLimit: mr.auto_recall_deep_limit,
    recencyHalfLifeMs: mr.auto_recall_recency_half_life_days * 86_400_000,
    recencyBoost: mr.auto_recall_recency_boost,
    mmrLambda: mr.auto_recall_mmr_lambda,
    dedupThreshold: mr.auto_recall_dedup_threshold,
    contextCutoffMs: lastKnown > 0 ? lastKnown : undefined,
    outsideContextBoost: mr.auto_recall_outside_context_boost,
    nowMs: n.query_ms,
  });
  const shown = [
    ...result.recent.map((h) => ({ ref: h.ref, block: "recent" as const })),
    ...result.deep.map((h) => ({ ref: h.ref, block: "deep" as const })),
  ];
  if (kind === "ack") {
    outcomes.push({
      id: n.id,
      kind,
      reached: false,
      block: null,
      position: null,
      shown: shown.length,
      blind: false,
      inSight: false,
    });
    continue;
  }
  const refs = new Set((n.needle_guids ?? []).map((g) => `msg:${g}`));
  const pos = shown.findIndex((s) => refs.has(s.ref));
  const needleRows = [...refs].map((r) => store.get(r)).filter((r) => r !== null);
  const oldestNeedleTs = Math.min(...needleRows.map((r) => r.ts));
  const outcome: Outcome = {
    id: n.id,
    kind,
    topic: n.topic,
    gapHours: n.gap_hours,
    reached: pos >= 0,
    block: pos >= 0 ? shown[pos]!.block : null,
    position: pos >= 0 ? pos + 1 : null,
    shown: shown.length,
    blind: lastAll > 0 && Number.isFinite(oldestNeedleTs) && oldestNeedleTs < lastAll,
    // Before the hook, sight began at the compaction itself; with it, where
    // the re-injected thread begins (the recall boundary).
    inSight:
      needleRows.length > 0 &&
      Math.max(...needleRows.map((r) => r.ts)) >=
        (boundary === "compaction" ? (excludeFromMs ?? lastAll) : lastAll),
  };
  if (needleRows.length === 0) {
    outcome.missReason = "not-indexed";
  } else {
    // Why it was missed: the needle's own cosine against the query, and
    // whether the time window ruled it out before scoring.
    const q = await embedQuery(provider, [query]);
    const qvec = normalize(q.vectors[0]!);
    let best = -1;
    for (const r of needleRows) {
      let dot = 0;
      for (let i = 0; i < qvec.length; i++) dot += qvec[i]! * r.vec[i]!;
      best = Math.max(best, dot);
    }
    outcome.needleCosine = Number(best.toFixed(3));
    if (!outcome.reached) {
      const cutoff = excludeFromMs ?? n.query_ms - windowMs;
      const newestNeedleTs = Math.max(...needleRows.map((r) => r.ts));
      if (oldestNeedleTs >= cutoff && newestNeedleTs >= cutoff) outcome.missReason = "window";
      else if (best < mr.auto_recall_min_score) outcome.missReason = "below-floor";
      else outcome.missReason = "ranked-out";
    }
  }
  outcomes.push(outcome);
}

const real = outcomes.filter((o) => o.kind === "needle");
const acks = outcomes.filter((o) => o.kind === "ack");
const rate = (xs: Outcome[]) =>
  xs.length === 0
    ? "—"
    : `${xs.filter((o) => o.reached).length}/${xs.length} (${Math.round((100 * xs.filter((o) => o.reached).length) / xs.length)}%)`;
const mrr =
  real.reduce((s, o) => s + (o.position ? 1 / o.position : 0), 0) / Math.max(1, real.length);
const bucket = (o: Outcome) =>
  (o.gapHours ?? 0) < 24 ? "1-24h" : (o.gapHours ?? 0) < 72 ? "1-3d" : "3d+";
const reasons: Record<string, number> = {};
for (const o of real) {
  if (o.inSight && !o.reached) reasons["in-sight"] = (reasons["in-sight"] ?? 0) + 1;
  else if (o.missReason) reasons[o.missReason] = (reasons[o.missReason] ?? 0) + 1;
}

console.log(
  `recall eval — ${label}  (boundary=${boundary}, needles=${real.length}, acks=${acks.length})`,
);
const reach = (xs: Outcome[]) => {
  const k = xs.filter((o) => o.reached || o.inSight).length;
  return `${k}/${xs.length} (${Math.round((100 * k) / Math.max(1, xs.length))}%)`;
};
console.log(`  verbatim reach   ${reach(real)}   (in sight, or recalled)`);
console.log(`  recalled         ${rate(real)}   MRR ${mrr.toFixed(3)}`);
console.log(
  `  blind needles    ${rate(real.filter((o) => o.blind))}   (older than the last compaction)`,
);
console.log(`  in-sight needles ${rate(real.filter((o) => !o.blind))}`);
for (const b of ["1-24h", "1-3d", "3d+"]) {
  const xs = real.filter((o) => bucket(o) === b);
  console.log(`  gap ${b.padEnd(6)}       reach ${reach(xs)}  recalled ${rate(xs)}`);
}
console.log(`  misses           ${JSON.stringify(reasons)}`);
if (acks.length > 0) {
  const mean = acks.reduce((s, o) => s + o.shown, 0) / acks.length;
  console.log(`  ack noise        mean ${mean.toFixed(1)} hits shown per subject-less message`);
}

const outDir = join(dataDir, "evals");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `recall-${label}.json`);
writeFileSync(outPath, `${JSON.stringify({ label, boundary, outcomes }, null, 2)}\n`);
console.log(`  detail           ${outPath}`);
store.close();
chatDb.close();
process.exit(0);
