/**
 * Sub-query planner for deep research. Decomposes a single research
 * question into 2-6 sibling sub-queries that fan out across angles.
 *
 * Two paths:
 *   - `planWithHaiku(question, depth)`: one-shot model planning call
 *     with a tight structured prompt, parse JSON output. Default.
 *   - `planHeuristic(question, depth)`: pure-code fallback. Used when
 *     Haiku is unavailable or in tests.
 *
 * Output is always an array of plain strings — full sub-queries the
 * researcher agents will receive verbatim.
 */

import { runModelOneShot } from "../model/one-shot.ts";
import { recordSpend } from "../spend/ledger.ts";

export type ResearchDepth = "quick" | "standard" | "thorough";

export const DEPTH_FANOUT: Record<ResearchDepth, number> = {
  quick: 2,
  standard: 4,
  thorough: 6,
};

const PLANNER_TIMEOUT_MS = 25_000;

const PLANNER_SYSTEM = `You decompose a research question into a set of
sibling sub-queries that fan out across the angles a thorough analyst
would investigate. Each sub-query must be:

- Self-contained (an agent will receive it with no other context).
- Specific enough to drive a concrete web search or source lookup.
- Distinct from its siblings — no two should yield the same searches.

Output STRICT JSON only. No preamble, no fences, no comments. Shape:

{"queries": ["...", "..."]}

The array must contain exactly the requested number of items.`;

export type PlanResult =
  | { ok: true; queries: string[]; via: "haiku" | "heuristic" }
  | { ok: false; reason: string; queries: string[] };

export function planHeuristic(question: string, depth: ResearchDepth): string[] {
  const n = DEPTH_FANOUT[depth];
  const base = question.trim().replace(/\s+/g, " ");
  const angles = [
    `${base} — overview and current state in 2026`,
    `${base} — recent news, releases, or developments`,
    `${base} — expert opinions, reviews, or comparisons`,
    `${base} — risks, criticisms, or counter-arguments`,
    `${base} — historical context and how we got here`,
    `${base} — practical next steps or how to apply this`,
  ];
  return angles.slice(0, n);
}

export async function planWithHaiku(
  question: string,
  depth: ResearchDepth,
  model = "claude-haiku-4-5",
  spend?: { dataDir: string; sessionKey: string },
): Promise<PlanResult> {
  const n = DEPTH_FANOUT[depth];
  const prompt = `Question: ${question}\n\nProduce exactly ${n} sibling sub-queries.`;
  const res = await runModelOneShot({
    args: [
      "--model",
      model,
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      PLANNER_SYSTEM,
    ],
    input: prompt,
    timeoutMs: PLANNER_TIMEOUT_MS,
  });
  if (spend) {
    recordSpend(spend.dataDir, {
      sessionKey: spend.sessionKey,
      subsystem: "research-planner",
      model: res.model ?? model,
      costUsd: res.costUsd,
      durMs: res.durationMs,
    });
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: `planner spawn failed: ${res.error ?? `exit=${res.status}`}`,
      queries: planHeuristic(question, depth),
    };
  }
  const parsed = parsePlannerOutput(res.text);
  if (parsed.length === 0) {
    return {
      ok: false,
      reason: "planner returned no parseable queries",
      queries: planHeuristic(question, depth),
    };
  }
  // Clamp to fanout — model occasionally overshoots.
  return { ok: true, queries: parsed.slice(0, n), via: "haiku" };
}

/**
 * Tolerant JSON parser: tries strict JSON first, then a fenced-code
 * extract, then a bare-line fallback (one sub-query per line).
 */
export function parsePlannerOutput(raw: string): string[] {
  const tryParse = (s: string): string[] | null => {
    try {
      const obj = JSON.parse(s) as { queries?: unknown };
      if (Array.isArray(obj.queries)) {
        const strs = obj.queries.filter(
          (q): q is string => typeof q === "string" && q.trim().length > 0,
        );
        return strs.length > 0 ? strs.map((s) => s.trim()) : null;
      }
    } catch {}
    return null;
  };

  const strict = tryParse(raw);
  if (strict) return strict;

  const fence = raw.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) return fenced;
  }

  // Last resort: extract lines starting with a list marker or bare lines.
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 5 && l.length < 500 && !l.startsWith("{") && !l.startsWith("}"));
  return lines;
}
