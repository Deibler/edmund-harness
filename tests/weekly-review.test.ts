import { describe, expect, test } from "bun:test";
import {
  type ReviewMsg,
  countLogSignals,
  isCorrection,
  isLeak,
  percentile,
  replyStats,
} from "../src/evals/weekly-review.ts";

const t0 = Date.UTC(2026, 9, 20, 12, 0);
const m = (fromMe: boolean, minute: number, text = "x"): ReviewMsg => ({
  fromMe,
  text,
  ms: t0 + minute * 60_000,
});

describe("the weekly review counts what people experienced", () => {
  test("a burst waits from its first message to the next reply", () => {
    const s = replyStats(
      [m(false, 0), m(false, 2), m(true, 5), m(false, 10), m(true, 11)],
      t0 + 3_600_000,
    );
    expect(s.bursts).toBe(2);
    expect(s.answered).toBe(2);
    expect(s.latenciesMs).toEqual([5 * 60_000, 60_000]);
    expect(s.unanswered24h).toBe(0);
  });

  test("a burst still unanswered after a day is counted; a recent one is not yet", () => {
    expect(replyStats([m(false, 0)], t0 + 25 * 3_600_000).unanswered24h).toBe(1);
    expect(replyStats([m(false, 0)], t0 + 3_600_000).unanswered24h).toBe(0);
  });

  test("corrections are found in the wordings people use", () => {
    expect(isCorrection("No, that's wrong, it was Tuesday")).toBe(true);
    expect(isCorrection("I already told you the dates")).toBe(true);
    expect(isCorrection("that's not what I asked")).toBe(true);
    expect(isCorrection("thanks, that's great")).toBe(false);
  });

  test("every registered control word counts as a leak", () => {
    expect(isLeak("KEEP_DRAFT")).toBe(true);
    expect(isLeak("KEEP_QUIET")).toBe(true);
    expect(isLeak("keep drafting the letter")).toBe(false);
  });

  test("percentiles of an empty set are unknown, not zero", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2, 3, 4], 50)).toBe(3);
  });

  test("log signals are counted inside the window only", () => {
    const log = [
      "2026-10-10T10:00:00.000Z [error] [cron] fire failed scheduled",
      "2026-10-21T10:00:00.000Z [error] [cron] fire failed scheduled",
      "2026-10-21T11:00:00.000Z [warn] [persona-consolidate] pass failed, archive held subject=dm:x",
    ].join("\n");
    const counts = countLogSignals(log, "2026-10-18T00:00:00.000Z");
    expect(counts.get("scheduled job failed")).toBe(1);
    expect(counts.get("consolidation failed, archive held")).toBe(1);
  });
});
