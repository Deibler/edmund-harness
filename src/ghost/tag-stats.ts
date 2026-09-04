import { reactionPolarity } from "./budget.ts";
import type { FireRecord } from "./prefs.ts";

/**
 * Cross-session tag→outcome rollup — the ghost's long-horizon learning
 * signal. Every fire carries model-authored telemetry tags; every
 * delivered fire eventually gets a behavioral outcome. Rolled together
 * across ALL chats they answer "which kinds of proactive moves actually
 * land for this user base" — a signal no single session's 10-fire
 * window can show.
 *
 * Pure functions over FireRecord[]; the store query lives in prefs
 * (allScoredFires). Rendered as one compact prompt block per tick.
 */

export type TagStat = {
  tag: string;
  scored: number;
  positive: number; // engaged + warm tapbacks
  negative: number; // ignored + pushed_back + 👎
  neutral: number; // ❓ / custom reactions
  /** positive / scored, in [0,1]. */
  hitRate: number;
};

/** Minimum scored fires before a tag's record is worth showing. */
export const MIN_SCORED_FOR_ROLLUP = 3;

export function tagTrackRecord(fires: FireRecord[]): TagStat[] {
  const byTag = new Map<string, { scored: number; positive: number; negative: number }>();
  for (const f of fires) {
    if (!f.outcome || f.outcome === "vetoed" || f.outcome === "error") continue;
    const polarity =
      f.outcome === "engaged"
        ? "positive"
        : f.outcome === "reacted"
          ? reactionPolarity(f.reactionGlyph)
          : "negative"; // ignored / pushed_back
    for (const raw of f.tags) {
      const tag = raw.trim().toLowerCase();
      if (!tag) continue;
      const s = byTag.get(tag) ?? { scored: 0, positive: 0, negative: 0 };
      s.scored++;
      if (polarity === "positive") s.positive++;
      if (polarity === "negative") s.negative++;
      byTag.set(tag, s);
    }
  }
  return [...byTag.entries()]
    .filter(([, s]) => s.scored >= MIN_SCORED_FOR_ROLLUP)
    .map(([tag, s]) => ({
      tag,
      scored: s.scored,
      positive: s.positive,
      negative: s.negative,
      neutral: s.scored - s.positive - s.negative,
      hitRate: s.positive / s.scored,
    }))
    .sort((a, b) => b.scored - a.scored || b.hitRate - a.hitRate);
}

/**
 * Render the prompt block. Empty string when no tag has enough data —
 * the block earns its tokens or doesn't appear.
 */
export function renderTagTrackRecord(stats: TagStat[], maxLines = 8): string {
  if (stats.length === 0) return "";
  const lines = [
    "TAG_TRACK_RECORD (your proactive moves across ALL chats, by tag — learn from this):",
  ];
  for (const s of stats.slice(0, maxLines)) {
    const verdict =
      s.hitRate >= 0.6
        ? "works — this kind of move lands"
        : s.hitRate <= 0.25
          ? "gets ignored — raise the bar or drop this angle"
          : "mixed";
    lines.push(
      `  - ${s.tag}: ${s.positive}/${s.scored} landed (${s.negative} negative) — ${verdict}`,
    );
  }
  return lines.join("\n");
}
