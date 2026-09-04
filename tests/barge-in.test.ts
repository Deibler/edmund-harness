/**
 * Barge-in detection (2026-07-28): a parked "stop"/"cancel"/pivot aborts
 * the in-flight turn instead of waiting minutes to be folded in.
 *
 * The bar for matching is deliberately high — a false positive kills a
 * healthy turn AND its warm worker, while a miss just parks the message
 * for the coalesce gate exactly as before.
 */
import { describe, expect, test } from "bun:test";
import { isBargeIn } from "../src/channels/barge-in.ts";

describe("isBargeIn", () => {
  test("bare cancel words match, with punctuation and case noise", () => {
    for (const t of [
      "stop",
      "STOP!",
      "stop stop",
      "cancel that",
      "cancel it",
      "abort",
      "nevermind",
      "never mind",
      "Never mind.",
      "forget it",
      "forget that",
      "scratch that",
      "wait stop",
      "no, stop",
      "wait",
      "hold on",
      "hang on",
      "hold up",
    ]) {
      expect(isBargeIn(t)).toBe(true);
    }
  });

  test("redirect opener + explicit cancel verb matches", () => {
    for (const t of [
      "wait, don't send that",
      "no cancel it",
      "actually forget it, order thai instead",
      "wait actually make it friday instead",
      "no, not that one — the blue one",
      "hold on, scratch that",
    ]) {
      expect(isBargeIn(t)).toBe(true);
    }
  });

  test("ordinary follow-ups never match", () => {
    for (const t of [
      "actually can you also add cheese",
      "no worries",
      "hang on let me check my calendar",
      "don't stop believing",
      "stop me if you've heard this one before but",
      "also make it two of them",
      "wait times at the DMV are crazy",
      "lol",
      "",
    ]) {
      expect(isBargeIn(t)).toBe(false);
    }
  });

  test("null / long messages never match", () => {
    expect(isBargeIn(null)).toBe(false);
    expect(isBargeIn(undefined)).toBe(false);
    expect(isBargeIn(`wait, don't send that. ${"x".repeat(300)}`)).toBe(false);
  });
});
