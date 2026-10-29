/**
 * Auto-compaction trigger.
 *
 * When a session's cached prefix grows past `threshold_tokens` (per the
 * `cache_read_input_tokens` / `cache_creation_input_tokens` Claude Code
 * reports on `result ok`), turn.ts injects Claude Code's built-in
 * `/compact` slash command into the warm worker's stdin via
 * `compactWarmSession()` (see src/claude/runner.ts and
 * WorkerPool.compactIfWarm in src/claude/pool.ts). That path compacts
 * the persistent JSONL in place and the session keeps running — no
 * cold-spawn, no homemade summarizer, no amnesia.
 *
 * This file used to host a fallback summarizer that spawned `claude -p`
 * to produce a brief, stashed it in compaction_state, and injected it
 * into the next cold envelope. It was lossy and caused total-amnesia
 * bugs when the 90s timeout fired. Removed 2026-05-17 after the
 * `/compact` path was proven.
 */

export type IterationUsage = {
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  input_tokens?: number;
};

export type CompactUsage = IterationUsage & {
  /** Per-API-call usage on the `result` event. Verified on CLI 2.1.220
   *  (2026-07-28, both `-p` one-shot and stream-json worker modes): the
   *  top-level token fields SUM every API call of the turn's tool loop,
   *  while `iterations` held a SINGLE entry matching the LAST call —
   *  not one entry per call as the name suggests. Treated here as "any
   *  entries present are real per-call numbers; take the max", which is
   *  correct for both the observed single-entry shape (the last call is
   *  the largest — context grows monotonically within a turn) and a
   *  future true per-call shape. */
  iterations?: IterationUsage[];
};

/** One API call's context size: cache_read (reused prefix) +
 *  cache_creation (newly cached prefix) + input_tokens (uncached
 *  suffix) are disjoint segments of the same request. */
export function iterationContextTokens(u: IterationUsage): number {
  return (
    (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0)
  );
}

/**
 * Best usage-derived estimate of the turn's real context size: the
 * largest single API call from `iterations` when present; otherwise the
 * turn totals with the historical max(read, create+input) formula —
 * exact for single-call turns, overcounts multi-tool turns (each
 * round-trip re-reads the prefix and the totals sum them).
 *
 * Prefer a measured per-call max from the streamed `assistant` events
 * (see worker.ts/runner.ts) over this — `iterations` is an undocumented
 * shape that already changed meaning once.
 */
export function contextTokens(usage: CompactUsage | undefined): number {
  if (!usage) return 0;
  const its = usage.iterations;
  if (its && its.length > 0) {
    let max = 0;
    for (const it of its) {
      const size = iterationContextTokens(it);
      if (size > max) max = size;
    }
    return max;
  }
  const read = usage.cache_read_input_tokens ?? 0;
  const create = usage.cache_creation_input_tokens ?? 0;
  return Math.max(read, create + (usage.input_tokens ?? 0));
}

/**
 * What the harness's own `/compact` asks the summary to keep. A bare
 * `/compact` leaves the choice to the summariser, and it kept pointers
 * rather than words: on 2026-10-26 the summary held the path of a draft
 * file, not the post the operator had actually published, so the next reply
 * rebuilt the post from the draft until the operator said "stop altering". Tune a
 * compaction prompt for recall first (Anthropic, "Effective context
 * engineering for AI agents"). The CLI's own auto-compactions take no
 * instructions, which is why the verbatim thread is also re-injected after
 * every compaction (SessionStart hook, see post-compact-thread.ts).
 */
export const COMPACT_INSTRUCTIONS =
  "Keep, in the person's own words, every instruction, decision, correction, preference and " +
  "constraint they gave, and the exact final text of anything sent, posted or approved. For each " +
  "open task keep its exact state, what is left to do, and the file paths and links it uses. " +
  "Drop raw tool output.";

/**
 * A compaction Claude Code reported on its stream. The harness's own
 * `/compact` arrives as `manual`; the CLI compacting by itself mid-turn
 * (CLAUDE_CODE_AUTO_COMPACT_WINDOW) arrives as `auto`.
 */
export type CompactionEvent = {
  trigger: "auto" | "manual";
  preTokens?: number;
  postTokens?: number;
  atMs: number;
};

/**
 * Read a `{type:"system", subtype:"compact_boundary"}` stream event.
 *
 * Until 2026-10-29 both stream parsers ignored it, so the harness never
 * learned of the CLI's own compactions: 108 of the 155 in the operator's DM from
 * 10-12 to 10-29. Recall's boundary went stale, and the per-call context
 * max still held the pre-compaction size, so the harness compacted the
 * freshly compacted conversation again: 31 of 60 harness compactions in one
 * session ran on a context already under 190k (measured from the
 * transcript's compact_boundary rows).
 */
export function compactionFromEvent(evt: unknown, atMs = Date.now()): CompactionEvent | null {
  if (typeof evt !== "object" || evt === null) return null;
  const e = evt as { type?: unknown; subtype?: unknown; compact_metadata?: unknown };
  if (e.type !== "system" || e.subtype !== "compact_boundary") return null;
  const meta = (e.compact_metadata ?? {}) as {
    trigger?: unknown;
    pre_tokens?: unknown;
    post_tokens?: unknown;
  };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    trigger: meta.trigger === "manual" ? "manual" : "auto",
    preTokens: num(meta.pre_tokens),
    postTokens: num(meta.post_tokens),
    atMs,
  };
}

/**
 * The per-call context max to carry on after a compaction: what the CLI says
 * the conversation now holds, or nothing until the next call measures it.
 * Calls from before the boundary describe a conversation that no longer
 * exists.
 */
export function contextAfterCompaction(c: CompactionEvent): number {
  return c.postTokens ?? 0;
}

/**
 * Decide whether the turn that just finished should trigger a compact.
 * Pure: tests can call this with synthetic usage shapes.
 *
 * `measuredContextTokens` is the per-call max the worker/runner tracked
 * from streamed assistant-event usage — the most reliable signal, exact
 * on every CLI version that streams events. When absent (0/undefined),
 * fall back to the usage-derived estimate (see contextTokens).
 *
 * `compactedThisTurn`: the conversation was compacted during the turn, so
 * the measured max covers only what came after, and a zero means no call
 * followed. The usage totals still sum every call before the boundary, so
 * they are no fallback then.
 *
 * Comparing the turn-total cache reads instead tripped compacts at ~13%
 * of the threshold on tool-heavy turns (observed 2026-07-28: 10
 * round-trips summing to 1.03M reads over a 107k context).
 */
export function shouldCompact(
  usage: CompactUsage | undefined,
  cfg: { enabled: boolean; threshold_tokens: number },
  measuredContextTokens?: number,
  compactedThisTurn = false,
): boolean {
  if (!cfg.enabled) return false;
  const measured = measuredContextTokens ?? 0;
  if (compactedThisTurn) return measured >= cfg.threshold_tokens;
  const ctx = measured > 0 ? measured : contextTokens(usage);
  return ctx >= cfg.threshold_tokens;
}
