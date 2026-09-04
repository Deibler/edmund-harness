import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorAlert } from "../alerts/operator-alert.ts";
import { PERSONA_DIR } from "../claude/persona.ts";
import { OUTPUT_RULES } from "../claude/system-prompt.ts";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import { runModelOneShot } from "../model/one-shot.ts";
import { recordSpend } from "../spend/ledger.ts";
import { log } from "../util/log.ts";
import { judgeSample, sampleTranscripts } from "./judge.ts";
import { type EvalRun, type EvalScore, EvalStore } from "./store.ts";

/**
 * Eval loop v1 (roadmap #29).
 *
 * Two entry points, both cheap and both writing to spend.db:
 *
 *   runWeeklyEval        — judge a sample of REAL recent transcripts
 *                          against the live output contract. The drift
 *                          detector: catches slow degradation in the
 *                          things users actually receive.
 *
 *   maybeRunPersonaProbes — a FIXED prompt set replayed only when the
 *                          persona/output-contract fingerprint changes.
 *                          The regression detector: same inputs before
 *                          and after an edit, so score deltas are
 *                          attributable to the edit.
 *
 * Regression alerting compares each run's per-axis averages to the
 * previous run of the SAME kind; a drop ≥ config.evals.regression_
 * threshold raises one operator alert naming the axis.
 */

const WEEK_MS = 7 * 86_400_000;
const PROBE_GEN_TIMEOUT_MS = 120_000;

/** Persona surfaces whose edits should re-trigger the probe set. */
const FINGERPRINT_FILES = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "VENUE_DM.md", "HOME.md"];

/**
 * Fixed regression probes. Each hits a known failure mode of the output
 * contract. Do not casually reword — stable inputs are what make
 * before/after comparisons meaningful.
 */
const PERSONA_PROBES: Array<{ id: string; prompt: string }> = [
  { id: "casual-checkin", prompt: "yo what's good" },
  {
    id: "depth-temptation",
    prompt: "what should I know before buying my first used truck?",
  },
  {
    id: "list-temptation",
    prompt: "whats the best bait for flounder around here this time of year",
  },
  { id: "are-you-ai", prompt: "wait are you actually a real person or an AI" },
  {
    id: "emotional-checkin",
    prompt: "man today kinda sucked, work was brutal and I bombed the presentation",
  },
  {
    id: "explicit-list-ok",
    prompt: "can you list out the steps to winterize a camper? actual list please",
  },
  {
    id: "long-topic-discipline",
    prompt: "explain how mortgage rates work",
  },
  { id: "mechanics-question", prompt: "how do you actually work under the hood?" },
];

export type EvalDeps = {
  config: Config;
  chatDb: ChatDb;
  dataDir: string;
  alert?: OperatorAlert | null;
};

function checkRegression(
  store: EvalStore,
  run: EvalRun,
  threshold: number,
  alert: OperatorAlert | null | undefined,
): void {
  const prev = store.lastRun(run.kind, run.id);
  if (!prev || prev.nScored === 0 || run.nScored === 0) return;
  const axes: Array<[string, number, number]> = [
    ["format", prev.avgFormat, run.avgFormat],
    ["length", prev.avgLength, run.avgLength],
    ["persona", prev.avgPersona, run.avgPersona],
  ];
  const drops = axes.filter(([, was, now]) => was - now >= threshold);
  if (drops.length === 0) return;
  const detail = drops
    .map(([axis, was, now]) => `${axis} ${was.toFixed(1)}→${now.toFixed(1)}`)
    .join(", ");
  log.warn("evals", `regression detected (${run.kind}): ${detail}`);
  void alert?.notify({
    category: "eval-regression",
    error: `${run.kind} eval regressed: ${detail}`,
    context: { run_id: run.id, n_scored: run.nScored, prev_run_id: prev.id },
  });
}

/** Weekly transcript eval. No-op unless a week has passed since the
 *  last one (watermark in eval_meta) — call as often as convenient. */
export async function runWeeklyEvalIfDue(deps: EvalDeps, nowMs = Date.now()): Promise<boolean> {
  if (!deps.config.evals.enabled) return false;
  const store = new EvalStore(deps.dataDir);
  try {
    const last = Number(store.getMeta("last_weekly_ms") ?? 0);
    if (nowMs - last < WEEK_MS) return false;
    // Stamp FIRST so a crashing run can't hot-loop the judge.
    store.setMeta("last_weekly_ms", String(nowMs));

    const samples = sampleTranscripts(deps.chatDb, {
      days: 7,
      maxChats: deps.config.evals.weekly_samples,
      lines: 16,
    });
    if (samples.length === 0) {
      log.info("evals", "weekly eval: no outbound transcripts in window — skipped");
      return false;
    }
    const scores: EvalScore[] = [];
    for (const s of samples) {
      const r = await judgeSample(s, deps.config, {
        dataDir: deps.dataDir,
        sessionKey: "evals:weekly",
      });
      if (r) scores.push({ subject: s.subject, ...r });
    }
    const run = store.recordRun({
      kind: "weekly",
      startedAtMs: nowMs,
      model: deps.config.evals.judge_model,
      scores,
      note: `${scores.length}/${samples.length} samples judged`,
    });
    log.info(
      "evals",
      `weekly eval done: n=${run.nScored} format=${run.avgFormat.toFixed(1)} length=${run.avgLength.toFixed(1)} persona=${run.avgPersona.toFixed(1)}`,
    );
    checkRegression(store, run, deps.config.evals.regression_threshold, deps.alert);
    return true;
  } finally {
    store.close();
  }
}

/** Current persona/output-contract fingerprint. */
export function personaFingerprint(personaDir = PERSONA_DIR): string {
  const h = createHash("sha256");
  for (const f of FINGERPRINT_FILES) {
    const p = join(personaDir, f);
    if (existsSync(p)) h.update(f).update("\0").update(readFileSync(p));
  }
  h.update("output-rules\0").update(OUTPUT_RULES);
  return h.digest("hex");
}

/** Lean DM-shaped system prompt for probe generation: the persona core +
 *  the output contract, none of the tool/session machinery. Stable by
 *  construction — it's derived from exactly the fingerprinted surfaces. */
function probeSystemPrompt(personaDir: string): string {
  const read = (f: string) => {
    const p = join(personaDir, f);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  return [
    read("IDENTITY.md"),
    read("SOUL.md"),
    read("VENUE_DM.md"),
    `# Output contract\n\n${OUTPUT_RULES}`,
    "You are texting with a friend over iMessage. Reply to their message as Edmund. Your entire output is the reply text.",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/**
 * Replay the fixed probe set when the persona fingerprint changed.
 * First run establishes the baseline. Returns true when probes ran.
 */
export async function maybeRunPersonaProbes(deps: EvalDeps, nowMs = Date.now()): Promise<boolean> {
  if (!deps.config.evals.enabled || !deps.config.evals.probe_on_persona_change) return false;
  const store = new EvalStore(deps.dataDir);
  try {
    const current = personaFingerprint();
    const stored = store.getMeta("persona_fingerprint");
    if (stored === current) return false;
    // Stamp first — a crashing probe run must not replay every boot.
    store.setMeta("persona_fingerprint", current);
    log.info(
      "evals",
      stored ? "persona changed → replaying probe set" : "first probe baseline run",
    );

    const genModel = deps.config.evals.probe_model || deps.config.claude.model;
    const system = probeSystemPrompt(PERSONA_DIR);
    const scores: EvalScore[] = [];
    for (const probe of PERSONA_PROBES) {
      try {
        const gen = await runModelOneShot({
          args: [
            "--model",
            genModel,
            "--permission-mode",
            "bypassPermissions",
            "--append-system-prompt",
            system,
          ],
          input: probe.prompt,
          timeoutMs: PROBE_GEN_TIMEOUT_MS,
        });
        recordSpend(deps.dataDir, {
          sessionKey: "evals:probes",
          subsystem: "eval-probe",
          model: genModel,
          costUsd: gen.costUsd,
          durMs: gen.durationMs,
        });
        if (!gen.ok || gen.text.trim().length === 0) continue;
        const judged = await judgeSample(
          {
            subject: `probe:${probe.id}`,
            text: `them: ${probe.prompt}\nEDMUND: ${gen.text.trim()}`,
          },
          deps.config,
          { dataDir: deps.dataDir, sessionKey: "evals:probes" },
        );
        if (judged) scores.push({ subject: `probe:${probe.id}`, ...judged });
      } catch (err) {
        log.warn("evals", `probe ${probe.id} failed`, { err: (err as Error).message });
      }
    }
    const run = store.recordRun({
      kind: "probes",
      startedAtMs: nowMs,
      model: deps.config.evals.judge_model,
      scores,
      note: `gen=${genModel}; ${scores.length}/${PERSONA_PROBES.length} probes scored`,
    });
    log.info(
      "evals",
      `probe run done: n=${run.nScored} format=${run.avgFormat.toFixed(1)} length=${run.avgLength.toFixed(1)} persona=${run.avgPersona.toFixed(1)}`,
    );
    checkRegression(store, run, deps.config.evals.regression_threshold, deps.alert);
    return true;
  } finally {
    store.close();
  }
}
