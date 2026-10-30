/** The per-exchange timing line: every stage measured from when the caller stopped. */
import { describe, expect, test } from "bun:test";
import { describeTrace, newTrace } from "../src/calls/trace.ts";

describe("describeTrace", () => {
  test("each stage is ms after the caller stopped talking", () => {
    const t = {
      ...newTrace(),
      stoppedAt: 1_000,
      pausedAt: 1_400,
      probability: 0.914,
      finalAt: 1_520,
      handoffAt: 1_600,
      wordsAt: 2_300,
      soundAt: 2_950,
    };
    expect(describeTrace(t)).toEqual({
      gap_ms: 1_950,
      from: "speech end",
      pause_ms: 400,
      turn_p: 0.91,
      final_ms: 520,
      handoff_ms: 600,
      words_ms: 1_300,
      sound_ms: 1_950,
    });
  });

  test("without a speech-end time it measures from the final transcript, and says so", () => {
    const t = { ...newTrace(), finalAt: 5_000, handoffAt: 5_700, soundAt: 7_000 };
    expect(describeTrace(t)).toMatchObject({
      gap_ms: 2_000,
      from: "final transcript",
      pause_ms: "-",
    });
  });

  test("nothing to report until Edmund has made a sound in reply", () => {
    expect(describeTrace({ ...newTrace(), handoffAt: 10 })).toBeNull();
  });
});
