import type { HistoryLine } from "./history.ts";

/**
 * Conversation segmentation for the group-chat envelope.
 *
 * A "thread" is a contiguous run of messages with no internal silence
 * greater than `breakMs`. Two practical uses:
 *
 *   1. **Active-segment selection.** The envelope should only show the
 *      conversation that's directly relevant to the current invocation —
 *      i.e. the latest thread. If the previous thread was 3 days ago,
 *      injecting it as "recent history" misleads the model into thinking
 *      it's the same conversation.
 *
 *   2. **Topic-shift markers.** Within a thread, smaller gaps (a few
 *      minutes) often indicate a sub-topic shift. We expose them as
 *      indices so the renderer can inject `--- Xm gap ---` separators,
 *      letting the model see structure without doing arithmetic on
 *      timestamps.
 *
 * Both functions are pure (input lines → output structure) and have no
 * IO dependencies, so they're trivially unit-testable.
 */

export type Segment = {
  /** Oldest → newest, same ordering as the input. */
  lines: HistoryLine[];
  startMs: number;
  endMs: number;
};

/**
 * Split `lines` (oldest → newest) into segments wherever the silence
 * between two consecutive messages is at least `breakMs`. A `breakMs` of
 * 30 minutes means a 31-minute gap starts a new segment; a 29-minute gap
 * does not.
 *
 * Empty input returns an empty array. A single message yields one segment
 * with start == end.
 */
export function segmentByGaps(lines: HistoryLine[], breakMs: number): Segment[] {
  if (lines.length === 0) return [];
  const segments: Segment[] = [];
  let current: HistoryLine[] = [lines[0]!];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]!;
    const cur = lines[i]!;
    if (cur.timestampMs - prev.timestampMs >= breakMs) {
      segments.push(toSegment(current));
      current = [cur];
    } else {
      current.push(cur);
    }
  }
  segments.push(toSegment(current));
  return segments;
}

/**
 * Pick the segment that contains (or is immediately before) the invocation
 * timestamp. In practice this is the last segment — the inbound batch is
 * the freshest message, so it belongs to the most recent thread by
 * construction. We still take an explicit `inboundMs` so callers can
 * defensively pin the choice rather than relying on "last in array."
 *
 * Returns `null` only when `segments` is empty.
 */
export function pickActiveSegment(segments: Segment[], inboundMs: number): Segment | null {
  if (segments.length === 0) return null;
  // Prefer the segment whose [start, end] contains the invocation. If
  // none does (the invocation came after a gap, common case), return the
  // segment with the latest endMs — that's the one the invocation belongs
  // to as soon as it's appended.
  let best = segments[0]!;
  for (const s of segments) {
    if (inboundMs >= s.startMs && inboundMs <= s.endMs) return s;
    if (s.endMs > best.endMs) best = s;
  }
  return best;
}

/**
 * Within a single segment, return indices `i` (into segment.lines) such
 * that the gap between `lines[i-1]` and `lines[i]` is at least
 * `minorBreakMs`. The renderer injects a separator just before each
 * returned index.
 *
 * The threshold should be smaller than `breakMs` used for segmentation;
 * otherwise these would already be separate segments.
 */
export function findTopicShifts(segment: Segment, minorBreakMs: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < segment.lines.length; i++) {
    const gap = segment.lines[i]!.timestampMs - segment.lines[i - 1]!.timestampMs;
    if (gap >= minorBreakMs) out.push(i);
  }
  return out;
}

function toSegment(lines: HistoryLine[]): Segment {
  return {
    lines,
    startMs: lines[0]!.timestampMs,
    endMs: lines[lines.length - 1]!.timestampMs,
  };
}
