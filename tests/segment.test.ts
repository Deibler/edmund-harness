/**
 * Pure unit tests for the conversation segmenter. No DB, no IO.
 */
import { describe, expect, test } from "bun:test";
import type { HistoryLine } from "../src/imessage/history.ts";
import { findTopicShifts, pickActiveSegment, segmentByGaps } from "../src/imessage/segment.ts";

function line(rowId: number, timestampMs: number, who = "alice"): HistoryLine {
  return { rowId, timestampMs, fromHandle: who, fromMe: false, text: `msg ${rowId}` };
}

const MIN = 60_000;

describe("segmentByGaps", () => {
  test("empty input → empty output", () => {
    expect(segmentByGaps([], 30 * MIN)).toEqual([]);
  });

  test("single message → one segment with start == end", () => {
    const t = Date.now();
    const segs = segmentByGaps([line(1, t)], 30 * MIN);
    expect(segs.length).toBe(1);
    expect(segs[0]!.lines.length).toBe(1);
    expect(segs[0]!.startMs).toBe(t);
    expect(segs[0]!.endMs).toBe(t);
  });

  test("contiguous chatter under the break threshold stays one segment", () => {
    const t = Date.now();
    const lines = [line(1, t), line(2, t + 5 * MIN), line(3, t + 20 * MIN)];
    const segs = segmentByGaps(lines, 30 * MIN);
    expect(segs.length).toBe(1);
    expect(segs[0]!.lines.length).toBe(3);
  });

  test("a 31-minute gap splits into two segments (30m threshold)", () => {
    const t = Date.now();
    const lines = [
      line(1, t),
      line(2, t + 5 * MIN),
      line(3, t + 5 * MIN + 31 * MIN), // 31m after #2
      line(4, t + 5 * MIN + 31 * MIN + 2 * MIN),
    ];
    const segs = segmentByGaps(lines, 30 * MIN);
    expect(segs.length).toBe(2);
    expect(segs[0]!.lines.map((l) => l.rowId)).toEqual([1, 2]);
    expect(segs[1]!.lines.map((l) => l.rowId)).toEqual([3, 4]);
  });

  test("a gap exactly equal to the threshold still splits (>= semantics)", () => {
    const t = Date.now();
    const lines = [line(1, t), line(2, t + 30 * MIN)];
    const segs = segmentByGaps(lines, 30 * MIN);
    expect(segs.length).toBe(2);
  });
});

describe("pickActiveSegment", () => {
  test("returns null on empty input", () => {
    expect(pickActiveSegment([], Date.now())).toBeNull();
  });

  test("picks the most recent segment when invocation comes after the last endMs", () => {
    const t = Date.now();
    const segs = segmentByGaps(
      [line(1, t), line(2, t + 31 * MIN), line(3, t + 32 * MIN)],
      30 * MIN,
    );
    const inbound = t + 90 * MIN;
    const active = pickActiveSegment(segs, inbound);
    expect(active!.lines.map((l) => l.rowId)).toEqual([2, 3]);
  });

  test("picks the segment containing the invocation when one does", () => {
    const t = Date.now();
    const segs = segmentByGaps([line(1, t), line(2, t + 5 * MIN), line(3, t + 60 * MIN)], 30 * MIN);
    // Invocation at t+3min sits inside seg0 (which spans [t, t+5m]).
    const active = pickActiveSegment(segs, t + 3 * MIN);
    expect(active!.lines.map((l) => l.rowId)).toEqual([1, 2]);
  });
});

describe("findTopicShifts", () => {
  test("no internal gaps → no shifts", () => {
    const t = Date.now();
    const seg = {
      lines: [line(1, t), line(2, t + 30_000), line(3, t + 60_000)],
      startMs: t,
      endMs: t + 60_000,
    };
    expect(findTopicShifts(seg, 5 * MIN)).toEqual([]);
  });

  test("returns indices for gaps >= minorBreakMs", () => {
    const t = Date.now();
    const seg = {
      lines: [
        line(1, t),
        line(2, t + 60_000), // 1m gap → no shift
        line(3, t + 60_000 + 6 * MIN), // 6m gap → shift at index 2
        line(4, t + 60_000 + 6 * MIN + 30_000),
        line(5, t + 60_000 + 6 * MIN + 30_000 + 7 * MIN), // 7m gap → shift at index 4
      ],
      startMs: t,
      endMs: t + 60_000 + 6 * MIN + 30_000 + 7 * MIN,
    };
    expect(findTopicShifts(seg, 5 * MIN)).toEqual([2, 4]);
  });
});
