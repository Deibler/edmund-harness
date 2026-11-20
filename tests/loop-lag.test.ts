/**
 * The main thread's stall monitor: a timer that fires late was stopped for
 * that long. Driven here with its own clock.
 */
import { describe, expect, test } from "bun:test";
import { LoopLagMonitor } from "../src/boot/loop-lag.ts";

function monitor(onCall = false) {
  let now = 0;
  const stalls: { ms: number; onCall: boolean }[] = [];
  const lag = new LoopLagMonitor({
    intervalMs: 100,
    thresholdMs: 500,
    idleThresholdMs: 5_000,
    onCall: () => onCall,
    report: (stall) => stalls.push(stall),
    now: () => now,
  });
  lag.start();
  lag.stop(); // the clock below stands in for the timer
  return {
    lag,
    stalls,
    /** The timer fires `ms` after it last did. */
    fireAfter: (ms: number) => {
      now += ms;
      lag.beat();
    },
  };
}

describe("loop lag monitor", () => {
  test("says nothing while the timer fires on time", () => {
    const m = monitor();
    for (let i = 0; i < 50; i++) m.fireAfter(100 + (i % 3) * 40);
    expect(m.stalls).toEqual([]);
  });

  test("reports a stall with how long the thread was stopped", () => {
    const m = monitor();
    m.fireAfter(100);
    m.fireAfter(22_217); // the 2026-11-07 call: one query, 22 s
    m.fireAfter(100);
    expect(m.stalls).toEqual([{ ms: 22_117, onCall: false }]);
  });

  test("during a call, a second is reported, and that a call was live through it", () => {
    const m = monitor(true);
    m.fireAfter(100);
    m.fireAfter(1_100);
    expect(m.stalls).toEqual([{ ms: 1_000, onCall: true }]);
  });

  test("with no call up, the indexer's second or two a minute is not", () => {
    const m = monitor(false);
    m.fireAfter(100);
    m.fireAfter(2_200);
    m.fireAfter(100);
    expect(m.stalls).toEqual([]);
  });
});
