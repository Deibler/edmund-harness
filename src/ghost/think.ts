import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatHistoryLines } from "../channels/history-format.ts";
import type { OneShotResult } from "../claude/one-shot.ts";
import { loadPersona } from "../claude/persona.ts";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import type { HistoryLine } from "../imessage/history.ts";
import { getRecentMessages } from "../imessage/history.ts";
import { recentReactionsToMe } from "../imessage/reactions.ts";
import { listAttachments } from "../imessage/search.ts";
import { segmentByGaps } from "../imessage/segment.ts";
import { runModelOneShot } from "../model/one-shot.ts";
import { ensureSandbox, sandboxDir } from "../persona/sandbox.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { type SessionKey, chatIdFromKey, isGroupSession } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import { recordSpend } from "../spend/ledger.ts";
import { log } from "../util/log.ts";
import {
  type GateResult,
  checkActiveHours,
  checkCooldown,
  checkEnabled,
  checkOutstandingFire,
  checkWeeklyCap,
  decayMultiplier,
  focusSuggestionStatus,
  preflightGate,
} from "./budget.ts";
import { resolveIntensity } from "./intensity.ts";
import type { GhostPrefsStore } from "./prefs.ts";
import { renderTagTrackRecord, tagTrackRecord } from "./tag-stats.ts";

/**
 * Ghost tick — the proactive WORKING agent behind each chat.
 *
 * The flow:
 *   1. Pre-flight gates (enabled, active hours, cooldown, weekly cap).
 *      A failed gate short-circuits with `act: false, reason: <gate>`
 *      and zero model spend.
 *   2. Build a structured prompt: recent history, person file, time
 *      context, engagement trend, workspace paths, past decisions,
 *      fire outcomes, intensity-derived eagerness clause.
 *   3. Spawn `claude -p` as a tool-using agent (async — a tick can run
 *      minutes without blocking the daemon): it can WebSearch, read its
 *      workspace, stage drafts in brownnose/drafts, and MUST finish by
 *      calling the submit_decision MCP tool (src/ghost/mcp-server.ts),
 *      which writes the schema-validated decision to a file.
 *   4. Read the decision file; fall back to parsing stdout JSON with
 *      salvage defaults if the tool was never called.
 *   5. Append the decision to `<sandbox>/brownnose/decisions.jsonl`.
 *   6. Return the decision. The observer enqueues act:true as a cron
 *      fire (brief + staged contextFiles) and persists snoozes.
 */

const GHOST_PROMPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "persona",
  "GHOST.md",
);

// The ghost runs on whatever `config.brown_nose.ghost_model` says (see
// config.toml — do not name a specific model in comments here, they rot).
// It's a tool-USING agent (web search, workspace writes, staged drafts),
// so a tick can legitimately take minutes.
const GHOST_SPAWN_TIMEOUT_MS = 300_000;
/** Hard wall across ALL attempts of one tick. Without it, a first attempt
 *  that burned the full spawn timeout bought a second full one — observed
 *  601s ticks against a "300s timeout". A retry only happens while at
 *  least a minute of this budget remains, and its spawn timeout is
 *  clamped to what's left. */
const GHOST_TOTAL_DEADLINE_MS = 360_000;
/** Agentic turn cap — enough for research + drafting + the decision call,
 *  low enough that a confused tick can't spiral. */
const GHOST_MAX_TURNS = 25;
/** The submit_decision MCP server (structured decision channel). */
const GHOST_MCP_SERVER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "mcp-server.ts");
const GHOST_RETRY_ATTEMPTS = 2;
/** Backoff between ghost spawn retries — a cold-spawn ETIMEDOUT often means
 *  the CLI/Anthropic side is briefly busy; an immediate re-spawn hits the same
 *  contention. */
const GHOST_RETRY_BACKOFF_MS = 1_500;

/**
 * Optional operator-alert hook, wired by main.ts after it constructs the
 * OperatorAlert instance. Repeated silent spawn failures (~4.5% of ticks
 * in production, alerting no one) surface here after
 * SPAWN_FAILURE_ALERT_THRESHOLD consecutive failures.
 */
let ghostAlert:
  | ((category: string, error: string, context?: Record<string, string | number>) => void)
  | null = null;
export function setGhostAlertHook(
  fn: (category: string, error: string, context?: Record<string, string | number>) => void,
): void {
  ghostAlert = fn;
}
let consecutiveSpawnFailures = 0;
const SPAWN_FAILURE_ALERT_THRESHOLD = 3;
/** Wide candidate window for the comprehensive history review. The ghost
 *  consumes most of these via a segment-level summary; only the tail
 *  TAIL_HISTORY_LINES are rendered as raw speaker-tagged lines. */
const HISTORY_LIMIT = 200;
/** How many of the most-recent messages we send raw (speaker-tagged).
 *  Older messages are folded into the segment summary instead. */
const TAIL_HISTORY_LINES = 50;
/** Gap (minutes) that splits the candidate window into conversational
 *  segments for the summary. Mirrors the envelope's thread_break value
 *  default — keeps "conversation episode" semantics consistent. */
const SEGMENT_BREAK_MIN = 30;
/** How many days of attachment volume to surface. */
const ATTACHMENT_WINDOW_DAYS = 14;
/** Max bytes of person-file body to inject. Keeps the ghost prompt
 *  bounded even when the person file is long. */
const PERSON_FILE_MAX_BYTES = 4000;

export type GhostInput = {
  sessionKey: SessionKey;
  /** Override "now" — useful for tests + CLI replay. */
  nowMs?: number;
  /** Bypass active-hours gate (operator-only, set by CLI --invoke). */
  bypassActiveHours?: boolean;
  /** Bypass cooldown + weekly cap (CLI --force). */
  bypassBudgets?: boolean;
  /** Bypass invoking the ghost model entirely; return the would-be prompt and
   *  decision shape only. Used for prompt iteration. */
  dryRun?: boolean;
};

export type GhostDeps = {
  config: Config;
  chatDb: ChatDb;
  contacts: ContactBook;
  prefs: GhostPrefsStore;
};

/** Telemetry stamped by runGhostTick on every decision (additive — old
 *  persisted rows simply lack them). */
type GhostTickTelemetry = {
  /** Wall-clock of the model phase (pre-screen and/or full tick). */
  elapsedMs?: number;
  /** Model that actually answered (from the CLI stream, not config). */
  model?: string;
  /** Spawn attempts the full tick took (1 = clean first try). */
  attempts?: number;
  /** CLI-reported spend for this tick's model call(s). */
  costUsd?: number;
};

export type GhostDecision =
  | ({
      act: false;
      reason: string;
      tickAtMs: number;
      gate?: GateResult;
      /** Ghost-requested snooze: "nothing will change here until the user
       *  acts — don't ask me again before this instant." Honored by the
       *  observer/picker for free; ALWAYS voided early by new inbound. */
      snoozeUntilMs?: number;
    } & GhostTickTelemetry)
  | ({
      act: true;
      tickAtMs: number;
      fireAtMs: number;
      brief: string;
      tags: string[];
      expiresAtMs: number;
      confidence: "low" | "medium" | "high";
      /** Absolute paths of work the ghost staged in its workspace (drafts,
       *  research) — handed to the main model in the fire envelope. */
      contextFiles?: string[];
    } & GhostTickTelemetry);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Pre-screen ───────────────────────────────────────────────────────
// Production telemetry (75 days): 774 full deliberations produced 35 acts —
// a 95.5% "no" rate at the expensive model's price. The pre-screen runs the
// same context through a cheap fast model first; only a "plausibly yes"
// buys the full tool-using deliberation. Fails OPEN: a broken pre-screen
// must never silence the ghost.

const PRESCREEN_TIMEOUT_MS = 90_000;
const PRESCREEN_SYSTEM = [
  `You are a fast triage filter in front of an expensive "should I proactively message this person" deliberation.`,
  `Read the context that follows and answer with STRICT JSON only, no prose: {"proceed": true|false, "reason": "<one short sentence>"}.`,
  `proceed=true means a proactive message is PLAUSIBLY worth composing right now — the expensive pass makes the real call, so borderline cases lean true.`,
  `proceed=false when it's clearly not the moment: conversation dormant with nothing new to add, mid-flow with nothing owed, an open thread already waiting on them, or a recent proactive touch.`,
].join("\n");

type PreScreenVerdict = {
  proceed: boolean;
  reason: string;
  durationMs: number;
  model: string | null;
};

async function runPreScreen(
  promptInput: string,
  config: Config,
  sessionKey: SessionKey,
): Promise<PreScreenVerdict | null> {
  const r = await runModelOneShot({
    args: [
      "--model",
      config.brown_nose.prescreen_model,
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      PRESCREEN_SYSTEM,
    ],
    input: promptInput,
    timeoutMs: PRESCREEN_TIMEOUT_MS,
  });
  recordSpend(config.paths.data_dir, {
    sessionKey,
    subsystem: "ghost-prescreen",
    model: r.model ?? config.brown_nose.prescreen_model,
    costUsd: r.costUsd,
    durMs: r.durationMs,
  });
  if (!r.ok) {
    log.warn("ghost", "pre-screen failed — failing open to full tick", {
      session: sessionKey,
      err: r.error ?? "unknown",
    });
    return null;
  }
  const m = r.text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { proceed?: unknown; reason?: unknown };
    if (typeof parsed.proceed !== "boolean") return null;
    return {
      proceed: parsed.proceed,
      reason: typeof parsed.reason === "string" ? parsed.reason : "(no reason given)",
      durationMs: r.durationMs,
      model: r.model,
    };
  } catch {
    return null;
  }
}

export async function runGhostTick(input: GhostInput, deps: GhostDeps): Promise<GhostDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const tickAtMs = nowMs;
  const { config, chatDb, contacts, prefs } = deps;

  // 1. Load prefs. Bail loudly if missing — the caller should have run
  //    autoEnroll first.
  const sessionPrefs = prefs.get(input.sessionKey);
  if (!sessionPrefs) {
    const dec: GhostDecision = {
      act: false,
      reason: "no prefs row for session (run autoEnrollSessions first)",
      tickAtMs,
    };
    writeDecision(input.sessionKey, dec);
    return dec;
  }
  // Effective weekly cap tracks the CURRENT intensity (boot-time
  // syncWeeklyCapsToIntensity restamps stale rows; this is the belt to
  // that suspender so a mid-run intensity bump applies immediately).
  sessionPrefs.weeklyCap = Math.max(
    sessionPrefs.weeklyCap,
    resolveIntensity(config.brown_nose.intensity).weeklyCap,
  );

  // 2. Pull engagement history for decay computation. We always recompute
  //    the multiplier from outcomes so a stale row doesn't lock us
  //    into a high multiplier forever.
  const recentFires = prefs.recentFires(input.sessionKey, 10);
  const weekAgo = nowMs - 7 * 24 * 3_600_000;
  const weekFires = recentFires.filter((f) => f.firedAtMs >= weekAgo);
  const currentMultiplier = decayMultiplier(recentFires);
  if (currentMultiplier !== sessionPrefs.cooldownMultiplier) {
    prefs.upsert(input.sessionKey, { cooldownMultiplier: currentMultiplier });
    sessionPrefs.cooldownMultiplier = currentMultiplier;
  }

  // 3. Pre-flight gates. Bypass selectively for CLI overrides.
  const gateChecks: Array<{ name: string; result: GateResult }> = [
    { name: "enabled", result: checkEnabled(sessionPrefs, config.brown_nose.enabled) },
  ];
  if (!input.bypassActiveHours) {
    gateChecks.push({ name: "active_hours", result: checkActiveHours(sessionPrefs, nowMs) });
  }
  if (!input.bypassBudgets) {
    gateChecks.push({
      name: "cooldown",
      result: checkCooldown(sessionPrefs, recentFires, config.brown_nose.intensity, nowMs),
    });
    gateChecks.push({ name: "weekly_cap", result: checkWeeklyCap(sessionPrefs, weekFires) });
  }
  for (const { name, result } of gateChecks) {
    if (!result.ok) {
      const dec: GhostDecision = {
        act: false,
        reason: `${name}: ${result.reason}`,
        tickAtMs,
        gate: result,
      };
      writeDecision(input.sessionKey, dec);
      return dec;
    }
  }

  if (!input.bypassBudgets) {
    // One open proactive thread at a time: if the last fire is still
    // unanswered, don't even wake the model. Runs AFTER the cheap gates
    // (it touches chat.db) and only when they all passed.
    const guids = chatGuidsForSession(input.sessionKey, chatDb, contacts);
    let lastInboundMs = 0;
    for (const g of guids) {
      const latest = getRecentMessages(chatDb, g, Number.MAX_SAFE_INTEGER, 10)
        .filter((m) => !m.fromMe)
        .at(-1);
      if (latest && latest.timestampMs > lastInboundMs) lastInboundMs = latest.timestampMs;
    }
    const outstanding = checkOutstandingFire(recentFires, lastInboundMs);
    if (!outstanding.ok) {
      const dec: GhostDecision = {
        act: false,
        reason: `outstanding_fire: ${outstanding.reason}`,
        tickAtMs,
        gate: outstanding,
      };
      writeDecision(input.sessionKey, dec);
      return dec;
    }
  }

  // 4. Build the prompt context.
  const promptInput = buildPromptInput({
    sessionKey: input.sessionKey,
    sessionPrefs,
    nowMs,
    config,
    chatDb,
    contacts,
    recentFires,
    // Cross-session tag→outcome rollup: 90 days is enough history for
    // stable per-tag rates without letting ancient behavior dominate.
    allScoredFires: prefs.allScoredFires(nowMs - 90 * 86_400_000),
  });

  if (input.dryRun) {
    // Test-mode: don't call the model. Return a synthetic act:false with
    // the prompt input embedded as the reason so callers can verify
    // prompt shape.
    const dec: GhostDecision = {
      act: false,
      reason: `dry-run (would invoke the ghost model with prompt of ${promptInput.length} chars)`,
      tickAtMs,
    };
    writeDecision(input.sessionKey, dec);
    return dec;
  }

  // 4.5 Cheap pre-screen before the expensive tool-using deliberation.
  //     Skipped on CLI --force (bypassBudgets); fails open on any error.
  //     Both verdicts are logged so a calibration pass can compare the
  //     pre-screen's "proceed" rate against the full tick's act rate.
  if (config.brown_nose.prescreen_enabled && !input.bypassBudgets) {
    const pre = await runPreScreen(promptInput, config, input.sessionKey);
    if (pre) {
      log.info("ghost", "pre-screen verdict", {
        session: input.sessionKey,
        proceed: pre.proceed,
        reason: pre.reason.slice(0, 160),
        elapsed_ms: pre.durationMs,
      });
      if (!pre.proceed) {
        const dec: GhostDecision = {
          act: false,
          reason: `pre-screen: ${pre.reason}`,
          tickAtMs,
          elapsedMs: pre.durationMs,
          model: pre.model ?? config.brown_nose.prescreen_model,
          attempts: 0,
        };
        writeDecision(input.sessionKey, dec);
        return dec;
      }
    }
  }

  // 5. Spawn the ghost as a tool-USING agent. It can research (WebSearch/
  //    WebFetch), read the chat workspace, stage drafts in brownnose/, and
  //    MUST end by calling the submit_decision MCP tool — schema-validated,
  //    written to decisionPath by the server. Stdout JSON is fallback only.
  //    Retry once on transient spawn failure (ETIMEDOUT, non-zero exit) —
  //    Anthropic-side hiccups and CLI cold starts both surface here.
  const systemPrompt = readGhostSystemPrompt(config.brown_nose.intensity);
  const decisionPath = join(ensureBrownnoseDir(input.sessionKey), `.decision-${tickAtMs}.json`);
  const mcpConfig = JSON.stringify({
    mcpServers: {
      ghost: {
        command: process.execPath,
        args: [GHOST_MCP_SERVER_PATH],
        env: {
          GHOST_DECISION_PATH: decisionPath,
          // Lets submit_decision validate fire_at_ms against this chat's
          // allowed hours AT SUBMIT TIME — a bad time comes back as a tool
          // error the model fixes, instead of a silent downstream clamp.
          GHOST_TIME_GUARD: JSON.stringify({
            activeHours: sessionPrefs.activeHours,
            timezone: sessionPrefs.timezone,
          }),
        },
      },
    },
  });
  const startedAtMs = Date.now();
  let res: OneShotResult | null = null;
  let lastReason = "";
  let attempts = 0;
  for (let attempt = 1; attempt <= GHOST_RETRY_ATTEMPTS; attempt++) {
    attempts = attempt;
    const remainingMs = GHOST_TOTAL_DEADLINE_MS - (Date.now() - startedAtMs);
    res = await runModelOneShot({
      args: [
        "--model",
        config.brown_nose.ghost_model,
        "--permission-mode",
        "bypassPermissions",
        "--mcp-config",
        mcpConfig,
        "--strict-mcp-config",
        "--max-turns",
        String(GHOST_MAX_TURNS),
        "--append-system-prompt",
        systemPrompt,
      ],
      input: promptInput,
      timeoutMs: Math.min(GHOST_SPAWN_TIMEOUT_MS, Math.max(remainingMs, 60_000)),
    });
    recordSpend(config.paths.data_dir, {
      sessionKey: input.sessionKey,
      subsystem: "ghost",
      model: res.model ?? config.brown_nose.ghost_model,
      costUsd: res.costUsd,
      durMs: res.durationMs,
    });
    const decided = existsSync(decisionPath);
    if (decided) break;
    if (res.ok) break;
    lastReason = `ghost spawn failed (attempt ${attempt}/${GHOST_RETRY_ATTEMPTS}): ${res.error ?? `exit=${res.status}`} stderr=${res.stderr.slice(0, 200)}`;
    if (attempt < GHOST_RETRY_ATTEMPTS) {
      if (GHOST_TOTAL_DEADLINE_MS - (Date.now() - startedAtMs) < 60_000) {
        lastReason += " — total tick deadline reached, not retrying";
        break;
      }
      log.warn("ghost", "spawn retrying", { session: input.sessionKey, reason: lastReason });
      await sleep(GHOST_RETRY_BACKOFF_MS);
    }
  }
  const elapsedMs = Date.now() - startedAtMs;
  const telemetry: { elapsedMs: number; model?: string; attempts: number; costUsd?: number } = {
    elapsedMs,
    attempts,
    ...(res?.model ? { model: res.model } : {}),
    ...(typeof res?.costUsd === "number" ? { costUsd: res.costUsd } : {}),
  };

  // Primary channel: the decision file written by submit_decision.
  const fromTool = readDecisionFile(decisionPath, tickAtMs);
  if (fromTool === null && (!res || !res.ok)) {
    const dec: GhostDecision = { act: false, reason: lastReason, tickAtMs, ...telemetry };
    log.warn("ghost", "spawn failed", { session: input.sessionKey, reason: lastReason });
    consecutiveSpawnFailures++;
    if (consecutiveSpawnFailures >= SPAWN_FAILURE_ALERT_THRESHOLD) {
      ghostAlert?.(
        "ghost spawn failures",
        `${consecutiveSpawnFailures} consecutive ghost ticks failed to spawn. Latest: ${lastReason.slice(0, 300)}`,
        { session: input.sessionKey },
      );
    }
    writeDecision(input.sessionKey, dec);
    return dec;
  }
  consecutiveSpawnFailures = 0;

  const finalText = res?.text ?? "";
  const parsed: GhostDecision = {
    ...(fromTool ?? parseGhostOutput(finalText, tickAtMs)),
    ...telemetry,
  };
  log.info("ghost", "decision", {
    session: input.sessionKey,
    act: parsed.act,
    elapsed_ms: elapsedMs,
    cost_usd: telemetry.costUsd,
    chars: finalText.length,
  });
  writeDecision(input.sessionKey, parsed);
  return parsed;
}

/**
 * Build the JSON-ish prompt body the ghost reads after its system prompt.
 * Newline-separated sections so the ghost model has clear structure
 * without burning tokens on JSON syntax overhead.
 */
function buildPromptInput(args: {
  sessionKey: SessionKey;
  sessionPrefs: ReturnType<GhostPrefsStore["get"]> & object;
  nowMs: number;
  config: Config;
  chatDb: ChatDb;
  contacts: ContactBook;
  recentFires: ReturnType<GhostPrefsStore["recentFires"]>;
  /** Scored fires across ALL sessions for the tag rollup. Optional so
   *  prompt-shape tests don't need a populated store. */
  allScoredFires?: ReturnType<GhostPrefsStore["recentFires"]>;
}): string {
  const lines: string[] = [];
  lines.push(`SESSION: ${args.sessionKey}`);
  lines.push(`KIND: ${isGroupSession(args.sessionKey) ? "group" : "dm"}`);
  lines.push(`TIMEZONE: ${args.sessionPrefs.timezone}`);

  // ---- TIME_CONTEXT ----
  // Wide-angle picture of "when" so the ghost doesn't have to do
  // timezone arithmetic. Surfaces: local day-of-week + time-of-day
  // phrase, UTC instant, whether right now is inside the active window
  // (and how much of it is left), how long since the start of the
  // local day.
  const tc = describeTimeContext(
    args.nowMs,
    args.sessionPrefs.timezone,
    args.sessionPrefs.activeHours,
  );
  lines.push("TIME_CONTEXT:");
  lines.push(`  now (local):  ${tc.localFull}  (${tc.timeOfDay})`);
  lines.push(`  now (utc):    ${new Date(args.nowMs).toISOString()}`);
  lines.push(`  now (epoch-ms): ${args.nowMs}`);
  lines.push(
    `  epoch anchors — ALWAYS compute fire_at_ms/expires_at_ms as now + offset from these (never derive an absolute date yourself; a hand-built epoch once landed a year in the past):`,
  );
  lines.push(
    `    +1h=${args.nowMs + 3_600_000}  +6h=${args.nowMs + 6 * 3_600_000}  +24h=${args.nowMs + 24 * 3_600_000}  +48h=${args.nowMs + 48 * 3_600_000}  +7d=${args.nowMs + 7 * 24 * 3_600_000}`,
  );
  lines.push(`  day:          ${tc.dayOfWeek}`);
  lines.push(`  in window:    ${tc.insideWindow ? "yes" : "no"}`);
  if (tc.insideWindow && tc.minutesUntilClose !== null) {
    lines.push(
      `  closes in:    ${humanGap(tc.minutesUntilClose * 60_000)} (${tc.activeWindowLabel})`,
    );
  } else if (!tc.insideWindow && tc.minutesUntilOpen !== null) {
    lines.push(
      `  next window:  ${humanGap(tc.minutesUntilOpen * 60_000)} from now (${tc.activeWindowLabel})`,
    );
  }
  lines.push("");

  // Intensity-resolved eagerness reference.
  const intensity = resolveIntensity(args.config.brown_nose.intensity);
  lines.push(`INTENSITY: ${args.config.brown_nose.intensity}`);
  lines.push(
    `COOLDOWN_HOURS_EFFECTIVE: ${(intensity.cooldownHours * args.sessionPrefs.cooldownMultiplier).toFixed(1)}`,
  );
  lines.push(`WEEKLY_CAP: ${args.sessionPrefs.weeklyCap}`);
  lines.push("");

  // The user's own portal note — THEIR words about what proactive
  // contact they want. Highest-authority preference signal there is.
  if (args.sessionPrefs.userNote) {
    lines.push("USER_NOTE (written by the user themselves on their settings page — obey it):");
    lines.push(`  ${args.sessionPrefs.userNote.replace(/\n/g, "\n  ")}`);
    lines.push("");
  }

  // Focus suggestions — active and overused.
  const { active, overUsed } = focusSuggestionStatus(
    args.sessionPrefs.focusSuggestions,
    args.nowMs,
  );
  if (active.length > 0) {
    lines.push("FOCUS_SUGGESTIONS_ACTIVE:");
    for (const s of active) {
      lines.push(`  - ${s.topic} (used ${s.usageCount}/3 this week)`);
    }
  }
  if (overUsed.length > 0) {
    lines.push("FOCUS_SUGGESTIONS_OVERUSED (AVOID THESE THIS TICK):");
    for (const s of overUsed) lines.push(`  - ${s.topic}`);
  }
  if (active.length === 0 && overUsed.length === 0) {
    lines.push("FOCUS_SUGGESTIONS: (none)");
  }
  lines.push("");

  // Last decisions (so the ghost doesn't repeat itself).
  const recentDecisions = readRecentDecisions(args.sessionKey, 5);
  lines.push(`PRIOR_DECISIONS_NEWEST_FIRST (${recentDecisions.length}):`);
  if (recentDecisions.length === 0) {
    lines.push("  (none)");
  } else {
    for (const d of recentDecisions) {
      const when = new Date(d.tickAtMs).toISOString();
      if (d.act) {
        lines.push(
          `  ${when} ACT tags=${JSON.stringify(d.tags)} fireAt=${new Date(d.fireAtMs).toISOString()}`,
        );
        lines.push(`    brief: ${truncate(d.brief, 200)}`);
      } else {
        lines.push(`  ${when} NO reason="${truncate(d.reason, 120)}"`);
      }
    }
  }
  lines.push("");

  // Recent fires with outcomes — engagement signal.
  lines.push(`RECENT_FIRES (${args.recentFires.length}):`);
  if (args.recentFires.length === 0) {
    lines.push("  (none)");
  } else {
    for (const f of args.recentFires) {
      const when = new Date(f.firedAtMs).toISOString();
      const outcome =
        f.outcome === "reacted" && f.reactionGlyph
          ? `reacted ${f.reactionGlyph}`
          : (f.outcome ?? "pending");
      lines.push(
        `  ${when} [${outcome}] tags=${JSON.stringify(f.tags)} brief="${truncate(f.brief, 120)}"`,
      );
    }
  }
  lines.push("");

  // Tapbacks on the bot's messages — the lightest feedback channel
  // iMessage offers. A ❤️/😂 says the move landed even when no reply
  // came; a 👎 is push-back that never showed up as text.
  try {
    const guids = chatGuidsForSession(args.sessionKey, args.chatDb, args.contacts);
    const reactions = recentReactionsToMe(args.chatDb, guids, {
      sinceMs: args.nowMs - 14 * 86_400_000,
      limit: 6,
    });
    if (reactions.length > 0) {
      lines.push("REACTIONS_TO_YOUR_RECENT_MESSAGES (newest first — read the mood):");
      for (const r of reactions) {
        const when = new Date(r.atMs).toISOString().slice(0, 10);
        lines.push(`  ${when} ${r.glyph} on: "${truncate(r.targetText, 100)}"`);
      }
      lines.push(
        "  (❤️/👍/😂/‼️ = it landed; 👎 = pull back; ❓ = you confused them. Weigh these like replies.)",
      );
      lines.push("");
    }
  } catch {
    // Reactions are enrichment — a chat.db hiccup must not kill the tick.
  }

  // Cross-session tag track record — what KINDS of proactive moves land.
  const tagBlock = renderTagTrackRecord(tagTrackRecord(args.allScoredFires ?? []));
  if (tagBlock) {
    lines.push(tagBlock);
    lines.push("");
  }

  // Comprehensive history review. Pull a wide candidate window, then
  // present it in three layers so the ghost can see both the texture of
  // the conversation arc AND the freshest details:
  //
  //   1. SEGMENT_SUMMARY: every conversation episode in the window
  //      collapsed to one line — start/end, msg count, speakers, media.
  //      This is the long-horizon signal: "where has this chat been?"
  //
  //   2. TOPIC_DIGEST: most-mentioned tokens across the older portion
  //      of the window so the ghost knows what's been on the user's
  //      mind without needing to read every raw line.
  //
  //   3. RECENT_HISTORY: the last TAIL_HISTORY_LINES speaker-tagged
  //      lines verbatim, so the ghost sees the actual fresh content.
  const chatGuids = chatGuidsForSession(args.sessionKey, args.chatDb, args.contacts);
  const history = chatGuids.flatMap((g) =>
    getRecentMessages(args.chatDb, g, Number.MAX_SAFE_INTEGER, HISTORY_LIMIT),
  );
  history.sort((a, b) => a.timestampMs - b.timestampMs);

  const segments = segmentByGaps(history, SEGMENT_BREAK_MIN * 60_000);
  lines.push(`CONVERSATION_ARC: ${history.length} msgs across ${segments.length} episodes`);
  if (history.length > 0 && segments.length > 0) {
    const firstSeg = segments[0]!;
    const lastSeg = segments[segments.length - 1]!;
    lines.push(
      `  earliest: ${formatLocal(firstSeg.startMs, args.sessionPrefs.timezone)} (${humanGap(args.nowMs - firstSeg.startMs)} ago)`,
    );
    lines.push(
      `  latest: ${formatLocal(lastSeg.endMs, args.sessionPrefs.timezone)} (${humanGap(args.nowMs - lastSeg.endMs)} ago)`,
    );
  }
  lines.push("");

  lines.push(`SEGMENT_SUMMARY (${segments.length} episodes, oldest first):`);
  if (segments.length === 0) {
    lines.push("  (no messages — fresh session)");
  } else {
    // Cap segment lines so a very chatty user doesn't blow the budget.
    const renderedSegs = segments.slice(-30);
    if (renderedSegs.length < segments.length) {
      lines.push(`  ...${segments.length - renderedSegs.length} earlier episode(s) omitted`);
    }
    for (const seg of renderedSegs) {
      lines.push(`  ${describeSegment(seg, args.contacts, args.sessionPrefs.timezone)}`);
    }
  }
  lines.push("");

  // Topic digest — pulls common content tokens from the older portion
  // of the history. Gives the ghost a "what's been on their mind" view
  // that's cheaper than reading every old line. Stopwords filtered.
  const olderHistory = history.slice(0, Math.max(0, history.length - TAIL_HISTORY_LINES));
  const digest = topicDigest(olderHistory);
  if (digest.length > 0) {
    lines.push(`TOPIC_DIGEST (frequent terms in older messages):`);
    lines.push(`  ${digest.join(", ")}`);
    lines.push("");
  }

  // Recent attachment volume — visual conversation density signal.
  const sinceMs = args.nowMs - ATTACHMENT_WINDOW_DAYS * 24 * 3_600_000;
  const attCounts = attachmentCounts(args.chatDb, chatGuids, sinceMs, args.nowMs);
  lines.push(`MEDIA_VOLUME (last ${ATTACHMENT_WINDOW_DAYS}d):`);
  lines.push(
    `  images: ${attCounts.images}, voice: ${attCounts.voice}, video: ${attCounts.video}, other: ${attCounts.other}`,
  );
  lines.push("");

  // Engagement trajectory — is this chat heating up, steady, or going
  // cold? Weekly message counts give the ghost the trend, not just the
  // latest gap, so it can tell "quiet week in an active friendship"
  // (re-engage) from "chat that was always sparse" (leave alone).
  for (const l of describeEngagementTrend(history, args.nowMs)) lines.push(l);
  lines.push("");

  // The user's texting rhythm — when THEY are typically active, derived
  // from their own messages in the candidate window. This is the ghost's
  // "what are they probably up to right now" signal: a fire scheduled
  // into one of their habitual texting hours lands as a normal part of
  // their day; one scheduled into a dead zone reads as an interruption.
  for (const l of describeRhythm(history, args.sessionPrefs.timezone, args.nowMs)) {
    lines.push(l);
  }
  lines.push("");

  // Person file (DM only) — the durable "who is this person" signal.
  if (!isGroupSession(args.sessionKey)) {
    const personHandle = chatIdFromKey(args.sessionKey);
    const persona = loadPersona(null, personHandle);
    if (persona.person) {
      lines.push(`PERSON_FILE (${persona.person.name}):`);
      lines.push(truncate(persona.person.body, PERSON_FILE_MAX_BYTES));
      lines.push("");
    } else {
      lines.push(`PERSON_FILE: (none yet — no durable context for this contact)`);
      lines.push("");
    }
  }

  // The freshest TAIL_HISTORY_LINES verbatim. Speaker-tagged so the
  // ghost can attribute each line without arithmetic.
  const tail = history.slice(-TAIL_HISTORY_LINES);
  lines.push(`RECENT_HISTORY_VERBATIM (${tail.length}):`);
  if (tail.length === 0) {
    lines.push("  (no messages — fresh session)");
  } else {
    for (const l of formatHistoryLines(tail, args.contacts)) {
      lines.push(`  ${l.trim()}`);
    }
  }
  lines.push("");

  // ---- TIMELINE ----
  // Single chronological view of every event the ghost should be aware
  // of: now, last user message, last main reply, last proactive fire,
  // last ghost tick. Sorted newest-first with "X ago" labels so the ghost
  // doesn't need to subtract ISO timestamps.
  const lastInbound = history.filter((m) => !m.fromMe).at(-1);
  const lastOutbound = history.filter((m) => m.fromMe).at(-1);
  const lastProactiveFire = args.recentFires[0]; // recentFires is newest-first
  const lastGhostTick = recentDecisions[0]; // newest first per readRecentDecisions

  const timelineEvents: Array<{ ms: number; label: string }> = [];
  if (lastInbound) {
    timelineEvents.push({
      ms: lastInbound.timestampMs,
      label: `user sent last inbound (${truncate(lastInbound.text.replace(/\s+/g, " "), 60)})`,
    });
  }
  if (lastOutbound) {
    timelineEvents.push({
      ms: lastOutbound.timestampMs,
      label: "main model last replied (responding to user)",
    });
  }
  if (lastProactiveFire) {
    const outcome = lastProactiveFire.outcome ?? "pending";
    timelineEvents.push({
      ms: lastProactiveFire.firedAtMs,
      label: `last proactive fire [${outcome}] — brief: "${truncate(lastProactiveFire.brief, 60)}"`,
    });
  }
  if (lastGhostTick) {
    const summary = lastGhostTick.act
      ? `ACT (queued fire) — "${truncate(lastGhostTick.brief, 60)}"`
      : `NO — ${truncate(lastGhostTick.reason, 80)}`;
    timelineEvents.push({
      ms: lastGhostTick.tickAtMs,
      label: `last ghost tick: ${summary}`,
    });
  }
  timelineEvents.sort((a, b) => b.ms - a.ms);

  lines.push("TIMELINE (newest first):");
  lines.push(
    `  now              ${formatLocal(args.nowMs, args.sessionPrefs.timezone)}  ← you are here`,
  );
  if (timelineEvents.length === 0) {
    lines.push("  (no prior events for this session)");
  } else {
    for (const ev of timelineEvents) {
      const ago = humanGap(args.nowMs - ev.ms);
      const local = formatLocal(ev.ms, args.sessionPrefs.timezone);
      const agoCol = `-${ago}`.padEnd(16);
      lines.push(`  ${agoCol} ${local}  ${ev.label}`);
    }
  }
  lines.push("");

  // Workspace — the ghost can READ AND WRITE here with its file tools.
  const wsDir = brownnoseDir(args.sessionKey);
  lines.push("WORKSPACE (yours — use Read/Write tools with these absolute paths):");
  lines.push(`  notes:    ${join(wsDir, "current.md")} (your running memory between ticks)`);
  lines.push(`  drafts:   ${join(wsDir, "drafts")}/ (stage work for the main model here)`);
  lines.push(`  research: ${join(wsDir, "research")}/`);
  lines.push("");

  // Ghost workspace notes (if any).
  const currentNotes = readCurrentNotes(args.sessionKey);
  if (currentNotes) {
    lines.push("CURRENT_NOTES (from brownnose/current.md):");
    lines.push(truncate(currentNotes, 2000));
    lines.push("");
  }

  // Final directive.
  lines.push("---");
  lines.push(
    "Work first if work is warranted (research, draft, update your notes), then finish by CALLING the submit_decision tool exactly once. Text you print is ignored — only the tool call counts.",
  );
  return lines.join("\n");
}

/** Snooze sanity bounds: under 30min is pointless (sweep cadence is
 *  coarser), over 14 days risks forgetting a chat entirely. */
const SNOOZE_MIN_MS = 30 * 60_000;
const SNOOZE_MAX_MS = 14 * 24 * 3_600_000;

/** Read + delete the decision file written by the submit_decision MCP
 *  tool. null when the ghost never called the tool (fallback: stdout). */
function readDecisionFile(path: string, tickAtMs: number): GhostDecision | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return decisionFromObject(raw, tickAtMs);
  } catch (err) {
    return {
      act: false,
      reason: `decision file unreadable: ${(err as Error).message}`,
      tickAtMs,
    };
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // already gone — fine
    }
  }
}

function parseGhostOutput(stdout: string, tickAtMs: number): GhostDecision {
  // The model sometimes wraps JSON in ```json fences despite instructions.
  // Strip them, then take the first {...} balanced span.
  const trimmed = stdout.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0) {
    return {
      act: false,
      reason: `parse error: no JSON object found in haiku output (${stdout.length} chars)`,
      tickAtMs,
    };
  }
  const slice = trimmed.slice(start, end + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(slice);
  } catch (err) {
    return {
      act: false,
      reason: `parse error: ${(err as Error).message}; slice="${truncate(slice, 200)}"`,
      tickAtMs,
    };
  }
  if (!raw || typeof raw !== "object") {
    return { act: false, reason: "parse error: not an object", tickAtMs };
  }
  return decisionFromObject(raw as Record<string, unknown>, tickAtMs);
}

/** Normalize a raw decision object (from the submit_decision tool or
 *  stdout JSON) into a GhostDecision, salvaging what can be salvaged. */
function decisionFromObject(obj: Record<string, unknown>, tickAtMs: number): GhostDecision {
  if (obj.act === false) {
    const dec: GhostDecision = {
      act: false,
      reason: typeof obj.reason === "string" ? obj.reason : "(no reason given)",
      tickAtMs,
    };
    // Optional ghost-requested snooze. Accept either an absolute
    // snoozeUntilMs or relative snoozeHours; clamp to sane bounds.
    const until = numberOrNull(obj.snoozeUntilMs);
    const hours = numberOrNull(obj.snoozeHours);
    const requested = until ?? (hours !== null ? tickAtMs + hours * 3_600_000 : null);
    if (requested !== null && requested > tickAtMs) {
      dec.snoozeUntilMs = Math.min(
        Math.max(requested, tickAtMs + SNOOZE_MIN_MS),
        tickAtMs + SNOOZE_MAX_MS,
      );
    }
    return dec;
  }
  if (obj.act === true) {
    const brief = typeof obj.brief === "string" ? obj.brief : "";
    const tags = Array.isArray(obj.tags)
      ? obj.tags.filter((t): t is string => typeof t === "string")
      : [];
    const confidence =
      obj.confidence === "low" || obj.confidence === "medium" || obj.confidence === "high"
        ? obj.confidence
        : "low";
    // Salvage missing scheduling fields rather than dropping the act —
    // a null fireAtMs once cost a real fire. Only an empty brief is
    // fatal (there'd be nothing to wake the main model with).
    if (brief.length === 0) {
      return {
        act: false,
        reason: "parse error: act:true with empty brief — nothing to fire with",
        tickAtMs,
      };
    }
    // Clamp the fire time into a sane window. The ghost does date→epoch
    // arithmetic in its head and HAS produced a fire_at_ms exactly one
    // year in the past ("Wednesday" of 2025 — enqueue then dropped a real
    // act as expired). Past → fire now; beyond 14 days → 14 days (a hook
    // that far out should be re-found by a future tick anyway).
    const MAX_FIRE_DELAY_MS = 14 * 24 * 3_600_000;
    const rawFireAtMs = numberOrNull(obj.fireAtMs) ?? tickAtMs; // default: fire now
    const fireAtMs = Math.min(Math.max(rawFireAtMs, tickAtMs), tickAtMs + MAX_FIRE_DELAY_MS);
    // Expiry relative to the CLAMPED fire: a past-dated decision carries a
    // past-dated expiry too, so the raw value is meaningless once fire
    // moved. Keep the ghost's intended fire→expiry gap instead.
    const rawExpiresAtMs = numberOrNull(obj.expiresAtMs);
    const expiresAtMs =
      rawExpiresAtMs === null
        ? fireAtMs + 24 * 3_600_000
        : fireAtMs + (rawExpiresAtMs - rawFireAtMs);
    const contextFiles = Array.isArray(obj.contextFiles)
      ? obj.contextFiles.filter((f): f is string => typeof f === "string" && f.startsWith("/"))
      : undefined;
    return {
      act: true,
      tickAtMs,
      fireAtMs,
      brief,
      tags,
      // Floor the expiry at fire + 1h: the tick itself can take minutes
      // and enqueue adds up to ~35min of jitter — a sub-hour expiry is
      // never what the ghost meant, but it DID kill a real act once
      // (60s expiry vs a 109s tick = dead on arrival).
      expiresAtMs: Math.max(expiresAtMs, fireAtMs + 3_600_000),
      confidence,
      contextFiles: contextFiles?.length ? contextFiles : undefined,
    };
  }
  return {
    act: false,
    reason: `parse error: act is not a boolean (${typeof obj.act})`,
    tickAtMs,
  };
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Append the decision to <sandbox>/brownnose/decisions.jsonl. */
function writeDecision(sessionKey: SessionKey, decision: GhostDecision): void {
  const dir = ensureBrownnoseDir(sessionKey);
  const path = join(dir, "decisions.jsonl");
  try {
    appendFileSync(path, `${JSON.stringify(decision)}\n`);
  } catch (err) {
    log.warn("ghost", "failed to write decision", {
      session: sessionKey,
      path,
      err: (err as Error).message,
    });
  }
}

/** Read recent decisions from the jsonl (newest first). */
function readRecentDecisions(sessionKey: SessionKey, limit: number): GhostDecision[] {
  const path = join(brownnoseDir(sessionKey), "decisions.jsonl");
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    const out: GhostDecision[] = [];
    // Walk from the end backward.
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]!) as GhostDecision);
      } catch {
        // Skip malformed rows.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readCurrentNotes(sessionKey: SessionKey): string | null {
  const path = join(brownnoseDir(sessionKey), "current.md");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Path resolution — the brownnose/ subdir of the session sandbox. */
function brownnoseDir(sessionKey: SessionKey): string {
  return join(sandboxDir(sessionKey), "brownnose");
}

function ensureBrownnoseDir(sessionKey: SessionKey): string {
  // Make sure the parent sandbox exists too (cold sessions might not yet
  // have one). ensureSandbox is idempotent.
  ensureSandbox(sessionKey, null);
  const dir = brownnoseDir(sessionKey);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function readGhostSystemPrompt(intensity: number): string {
  let text = readFileSync(GHOST_PROMPT_PATH, "utf8");
  const params = resolveIntensity(intensity);
  text = text.replaceAll("{{eagernessClause}}", params.eagerness);
  return text;
}

function formatLocal(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * One-line description of a conversation episode: when, how long, who
 * spoke, message count, any attachments.
 */
function describeSegment(
  seg: { lines: HistoryLine[]; startMs: number; endMs: number },
  contacts: ContactBook,
  timezone: string,
): string {
  const start = formatLocal(seg.startMs, timezone);
  const span = humanGap(seg.endMs - seg.startMs) || "instant";
  const bySpeaker = new Map<string, number>();
  for (const l of seg.lines) {
    const who = l.fromMe ? "You" : (contacts.displayName(l.fromHandle) ?? l.fromHandle ?? "?");
    bySpeaker.set(who, (bySpeaker.get(who) ?? 0) + 1);
  }
  const speakerStr = [...bySpeaker.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([who, n]) => `${who} ${n}`)
    .join(" / ");
  return `${start} → +${span}, ${seg.lines.length} msgs (${speakerStr})`;
}

/**
 * Pull frequent content tokens from a body of messages. Strips
 * stopwords + short tokens, returns top-N by frequency. The ghost
 * reads this as "what's been on their mind" without needing to see
 * every old line.
 */
function topicDigest(lines: HistoryLine[]): string[] {
  if (lines.length === 0) return [];
  const stop = new Set([
    "the",
    "and",
    "but",
    "for",
    "you",
    "are",
    "was",
    "this",
    "that",
    "with",
    "have",
    "has",
    "had",
    "your",
    "they",
    "them",
    "would",
    "should",
    "could",
    "what",
    "when",
    "where",
    "there",
    "their",
    "from",
    "into",
    "about",
    "going",
    "just",
    "like",
    "okay",
    "yeah",
    "yes",
    "no",
    "not",
    "is",
    "of",
    "to",
    "in",
    "on",
    "it",
    "a",
    "i",
    "im",
    "ill",
    "its",
    "thats",
    "dont",
    "do",
    "did",
    "if",
    "or",
    "an",
    "as",
    "be",
    "we",
    "us",
    "me",
    "my",
    "he",
    "she",
    "her",
    "him",
    "his",
    "hers",
    "lol",
    "ok",
    "haha",
    "kinda",
    "sorta",
    "really",
    "actually",
    "literally",
    "edmund",
    "claude",
  ]);
  const counts = new Map<string, number>();
  for (const l of lines) {
    const tokens = l.text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length >= 4 && !stop.has(t) && !/^\d+$/.test(t));
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  // Drop singletons (one mention isn't a topic). Take top 15 by count.
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([t, n]) => `${t}×${n}`);
}

/**
 * Render the user's texting-rhythm profile from their own messages: which
 * local hours and days they actually text in, and whether "now" is one of
 * their habitual hours. Pure (exported for tests); empty array when there
 * isn't enough signal to say anything useful.
 */
export function describeRhythm(history: HistoryLine[], timezone: string, nowMs: number): string[] {
  const theirs = history.filter((m) => !m.fromMe);
  if (theirs.length < 10) return [];

  const byHour = new Array<number>(24).fill(0);
  const byDow = new Map<string, number>();
  for (const m of theirs) {
    const p = localParts(m.timestampMs, timezone);
    byHour[p.hour]! += 1;
    byDow.set(p.dow, (byDow.get(p.dow) ?? 0) + 1);
  }

  // Merge active hours (above ~half the uniform share) into ranges.
  const threshold = Math.max(1, theirs.length / 48);
  const ranges: Array<{ start: number; end: number; n: number }> = [];
  for (let h = 0; h < 24; h++) {
    if (byHour[h]! < threshold) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.end === h) {
      last.end = h + 1;
      last.n += byHour[h]!;
    } else {
      ranges.push({ start: h, end: h + 1, n: byHour[h]! });
    }
  }
  ranges.sort((a, b) => b.n - a.n);

  const fmtHour = (h: number) => `${(h % 24).toString().padStart(2, "0")}:00`;
  const rangeStr = ranges
    .slice(0, 3)
    .map(
      (r) => `${fmtHour(r.start)}-${fmtHour(r.end)} (${Math.round((100 * r.n) / theirs.length)}%)`,
    )
    .join(", ");
  const topDays = [...byDow.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => d)
    .join("/");

  const nowParts = localParts(nowMs, timezone);
  const nowTypical = byHour[nowParts.hour]! >= threshold;

  const out = [`USER_RHYTHM (from ${theirs.length} of their messages):`];
  if (rangeStr) out.push(`  usually texts: ${rangeStr} local`);
  if (topDays) out.push(`  busiest days: ${topDays}`);
  out.push(
    `  right now (${fmtHour(nowParts.hour)} ${nowParts.dow}): ${nowTypical ? "a typical texting hour for them" : "NOT one of their usual texting hours — an unprompted ping is more likely to interrupt"}`,
  );
  return out;
}

/**
 * Weekly message-count trend over the candidate window — the engagement
 * trajectory. Pure (exported for tests).
 */
export function describeEngagementTrend(history: HistoryLine[], nowMs: number): string[] {
  if (history.length < 8) return [];
  const WEEKS = 5;
  const theirs = new Array<number>(WEEKS).fill(0);
  const ours = new Array<number>(WEEKS).fill(0);
  for (const m of history) {
    const weeksAgo = Math.floor((nowMs - m.timestampMs) / (7 * 86_400_000));
    if (weeksAgo < 0 || weeksAgo >= WEEKS) continue;
    if (m.fromMe) ours[weeksAgo]! += 1;
    else theirs[weeksAgo]! += 1;
  }
  const cells = [];
  for (let w = WEEKS - 1; w >= 0; w--) {
    cells.push(`${w === 0 ? "this wk" : `-${w}wk`}: them ${theirs[w]}/us ${ours[w]}`);
  }
  const recent = theirs[0]! + theirs[1]!;
  const earlier = theirs[2]! + theirs[3]! + theirs[4]!;
  const verdict =
    recent === 0 && earlier > 0
      ? "GONE QUIET — was engaged, now silent. A genuinely useful artifact-drop is the re-engagement play; another check-in is not."
      : recent > earlier
        ? "warming up"
        : recent * 2 < earlier
          ? "cooling off"
          : "steady";
  return [`ENGAGEMENT_TREND (their messages per week): ${cells.join(" · ")}`, `  read: ${verdict}`];
}

/**
 * Counts of recent attachments by category (image/voice/video/other).
 * Quick "how visual is this conversation" signal for the ghost.
 */
function attachmentCounts(
  chatDb: ChatDb,
  chatGuids: string[],
  sinceMs: number,
  untilMs: number,
): { images: number; voice: number; video: number; other: number } {
  if (chatGuids.length === 0) return { images: 0, voice: 0, video: 0, other: 0 };
  const hits = chatGuids.flatMap((g) =>
    listAttachments(chatDb, {
      chatGuids: [g],
      sinceMs,
      untilMs,
      limit: 500,
    }),
  );
  let images = 0;
  let voice = 0;
  let video = 0;
  let other = 0;
  for (const h of hits) {
    const m = (h.mimeType || "").toLowerCase();
    if (m.startsWith("image/")) images++;
    else if (m.startsWith("audio/")) voice++;
    else if (m.startsWith("video/")) video++;
    else other++;
  }
  return { images, voice, video, other };
}

/** Coarse human-readable duration (s/m/h/d/w). Empty string for <1s. */
function humanGap(ms: number): string {
  if (ms < 1000) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms < 7 * 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms < 30 * 86_400_000) return `${Math.round(ms / (7 * 86_400_000))}w`;
  return `${Math.round(ms / (30 * 86_400_000))}mo`;
}

/**
 * Resolve `now` in the session's timezone into a rich descriptor: the
 * formatted local string, day-of-week, time-of-day phrase, and active-
 * window status (inside? closes/opens in N minutes? which window?).
 *
 * The ghost reads this instead of doing TZ arithmetic itself.
 */
function describeTimeContext(
  nowMs: number,
  timezone: string,
  activeHours: Array<{ dow: string; start: string; end: string }>,
): {
  localFull: string;
  dayOfWeek: string;
  timeOfDay: "early morning" | "morning" | "midday" | "afternoon" | "evening" | "night";
  insideWindow: boolean;
  minutesUntilClose: number | null;
  minutesUntilOpen: number | null;
  activeWindowLabel: string;
} {
  const local = localParts(nowMs, timezone);
  const minutes = local.hour * 60 + local.minute;

  // Time-of-day buckets (rough but useful for "Friday evening" framing)
  let timeOfDay: ReturnType<typeof describeTimeContext>["timeOfDay"];
  if (local.hour < 6) timeOfDay = "early morning";
  else if (local.hour < 11) timeOfDay = "morning";
  else if (local.hour < 14) timeOfDay = "midday";
  else if (local.hour < 18) timeOfDay = "afternoon";
  else if (local.hour < 22) timeOfDay = "evening";
  else timeOfDay = "night";

  // Inside any window today?
  let insideWindow = false;
  let minutesUntilClose: number | null = null;
  let activeWindowLabel = "";
  for (const w of activeHours) {
    if (w.dow !== local.dow) continue;
    const start = parseHHMMLocal(w.start);
    const end = parseHHMMLocal(w.end);
    if (start === null || end === null) continue;
    if (minutes >= start && minutes < end) {
      insideWindow = true;
      minutesUntilClose = end - minutes;
      activeWindowLabel = `${w.dow} ${w.start}-${w.end}`;
      break;
    }
  }

  // If not inside, when does the next window open?
  let minutesUntilOpen: number | null = null;
  if (!insideWindow && activeHours.length > 0) {
    const dowIdx: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };
    const todayIdx = dowIdx[local.dow] ?? 1;
    let best: { minutes: number; window: (typeof activeHours)[number] } | null = null;
    for (const w of activeHours) {
      const wIdx = dowIdx[w.dow];
      if (wIdx === undefined) continue;
      const start = parseHHMMLocal(w.start);
      if (start === null) continue;
      let daysOut = (wIdx - todayIdx + 7) % 7;
      // If it's the same day but the window is later today, that counts as 0 days out.
      if (daysOut === 0 && start <= minutes) daysOut = 7;
      const totalMinutes = daysOut * 24 * 60 + (start - minutes);
      if (!best || totalMinutes < best.minutes) {
        best = { minutes: totalMinutes, window: w };
      }
    }
    if (best) {
      minutesUntilOpen = best.minutes;
      activeWindowLabel = `${best.window.dow} ${best.window.start}-${best.window.end}`;
    }
  }

  return {
    localFull: formatLocal(nowMs, timezone),
    dayOfWeek: dayOfWeekName(local.dow),
    timeOfDay,
    insideWindow,
    minutesUntilClose,
    minutesUntilOpen,
    activeWindowLabel,
  };
}

function localParts(ms: number, timezone: string): { dow: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  let dow = "mon";
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "weekday") dow = p.value.toLowerCase();
    else if (p.type === "hour") hour = (Number.parseInt(p.value, 10) || 0) % 24;
    else if (p.type === "minute") minute = Number.parseInt(p.value, 10) || 0;
  }
  return { dow, hour, minute };
}

function parseHHMMLocal(s: string): number | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number.parseInt(m[1]!, 10);
  const min = Number.parseInt(m[2]!, 10);
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function dayOfWeekName(dow: string): string {
  return (
    {
      sun: "sunday",
      mon: "monday",
      tue: "tuesday",
      wed: "wednesday",
      thu: "thursday",
      fri: "friday",
      sat: "saturday",
    }[dow] ?? dow
  );
}

// Re-export for tests + observer.
export { parseGhostOutput, readRecentDecisions, writeDecision as recordDecisionNote };
