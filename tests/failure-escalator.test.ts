import { describe, expect, test } from "bun:test";
import { FailureEscalator } from "../src/util/failure-escalator.ts";

describe("FailureEscalator", () => {
  test("escalates exactly once after the threshold of consecutive failures", () => {
    const calls: Array<[number, unknown]> = [];
    const esc = new FailureEscalator({
      name: "t",
      threshold: 3,
      backoffFactor: 1,
      onEscalate: (n, err) => calls.push([n, err]),
    });
    esc.recordFailure(new Error("a"));
    esc.recordFailure(new Error("b"));
    expect(calls).toHaveLength(0);
    esc.recordFailure(new Error("c"));
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(3);
    // Further failures don't re-fire while still escalated.
    esc.recordFailure(new Error("d"));
    expect(calls).toHaveLength(1);
    expect(esc.failureCount).toBe(4);
    expect(esc.isEscalated).toBe(true);
  });

  test("a success resets the streak and calls onRecover if it had escalated", () => {
    const recovered: number[] = [];
    const esc = new FailureEscalator({
      name: "t",
      threshold: 2,
      backoffFactor: 1,
      onEscalate: () => {},
      onRecover: (n) => recovered.push(n),
    });
    esc.recordFailure(1);
    esc.recordFailure(2); // escalates
    expect(esc.isEscalated).toBe(true);
    esc.recordSuccess();
    expect(recovered).toEqual([2]);
    expect(esc.failureCount).toBe(0);
    expect(esc.isEscalated).toBe(false);
    // A success when nothing was wrong is a no-op (no onRecover).
    esc.recordSuccess();
    expect(recovered).toEqual([2]);
  });

  test("re-escalates after recovering then failing again", () => {
    let n = 0;
    const esc = new FailureEscalator({
      name: "t",
      threshold: 1,
      backoffFactor: 1,
      onEscalate: () => n++,
    });
    esc.recordFailure(1);
    expect(n).toBe(1);
    esc.recordSuccess();
    esc.recordFailure(1);
    expect(n).toBe(2);
  });

  test("backoff: after escalation, shouldSkip lets 1 of every backoffFactor cycles through", () => {
    const esc = new FailureEscalator({
      name: "t",
      threshold: 1,
      backoffFactor: 4,
      onEscalate: () => {},
    });
    expect(esc.shouldSkip()).toBe(false); // not escalated yet
    esc.recordFailure(1); // escalates
    // Next four shouldSkip() calls: skip, skip, skip, run
    expect(esc.shouldSkip()).toBe(true);
    expect(esc.shouldSkip()).toBe(true);
    expect(esc.shouldSkip()).toBe(true);
    expect(esc.shouldSkip()).toBe(false);
    expect(esc.shouldSkip()).toBe(true); // cycle repeats
    esc.recordSuccess();
    expect(esc.shouldSkip()).toBe(false); // backoff cleared
  });

  test("backoffFactor 1 means never skip", () => {
    const esc = new FailureEscalator({
      name: "t",
      threshold: 1,
      backoffFactor: 1,
      onEscalate: () => {},
    });
    esc.recordFailure(1);
    expect(esc.shouldSkip()).toBe(false);
    expect(esc.shouldSkip()).toBe(false);
  });
});
