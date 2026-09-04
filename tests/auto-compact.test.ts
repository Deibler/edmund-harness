/**
 * Tests for the auto-compact decision + the markCompacted persistence
 * path. The /compact injection itself (warm worker stdin → Claude Code)
 * is exercised via the worker/pool integration paths, not here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextTokens, shouldCompact } from "../src/claude/auto-compact.ts";
import { StateStore } from "../src/sessions/store.ts";

const CFG_ON = {
  enabled: true,
  threshold_tokens: 400_000,
};

describe("shouldCompact", () => {
  test("false when disabled", () => {
    expect(
      shouldCompact({ cache_read_input_tokens: 1_000_000 }, { ...CFG_ON, enabled: false }),
    ).toBe(false);
  });

  test("false when usage missing", () => {
    expect(shouldCompact(undefined, CFG_ON)).toBe(false);
  });

  test("trips on cache_read crossing threshold", () => {
    expect(shouldCompact({ cache_read_input_tokens: 400_001 }, CFG_ON)).toBe(true);
  });

  test("trips on cache_create + input crossing threshold (cold path)", () => {
    expect(
      shouldCompact({ cache_creation_input_tokens: 350_000, input_tokens: 100_000 }, CFG_ON),
    ).toBe(true);
  });

  test("false on small prefix", () => {
    expect(
      shouldCompact(
        { cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1_000 },
        CFG_ON,
      ),
    ).toBe(false);
  });

  test("threshold is configurable", () => {
    expect(
      shouldCompact(
        { cache_read_input_tokens: 100_001 },
        {
          ...CFG_ON,
          threshold_tokens: 100_000,
        },
      ),
    ).toBe(true);
  });

  test("multi-tool turn: cumulative reads past threshold do NOT trip when per-call context is small", () => {
    // The 2026-07-28 regression: 10 round-trips summed to ~1.03M reads
    // over a ~107k actual context, tripping an 800k threshold at ~13%.
    const iterations = Array.from({ length: 10 }, () => ({
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 3_000,
      input_tokens: 500,
    }));
    const usage = {
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 30_000,
      input_tokens: 5_000,
      iterations,
    };
    expect(shouldCompact(usage, { enabled: true, threshold_tokens: 800_000 })).toBe(false);
    expect(contextTokens(usage)).toBe(103_500);
  });

  test("multi-tool turn trips when a single call genuinely exceeds the threshold", () => {
    const usage = {
      cache_read_input_tokens: 2_000_000,
      iterations: [
        {
          cache_read_input_tokens: 780_000,
          cache_creation_input_tokens: 15_000,
          input_tokens: 200,
        },
        { cache_read_input_tokens: 795_000, cache_creation_input_tokens: 6_000, input_tokens: 100 },
      ],
    };
    expect(shouldCompact(usage, { enabled: true, threshold_tokens: 800_000 })).toBe(true);
    expect(contextTokens(usage)).toBe(801_100);
  });

  test("empty iterations array falls back to turn totals", () => {
    expect(contextTokens({ cache_read_input_tokens: 450_000, iterations: [] })).toBe(450_000);
  });

  test("measured per-call context wins over summed totals (old CLI without iterations)", () => {
    // Worker measured the real largest call at 107k; the result event's
    // totals sum 10 round-trips to 1M. Measured must win — falling back
    // to (or maxing with) the summed totals reintroduces the false trip.
    const usage = { cache_read_input_tokens: 1_000_000 };
    expect(shouldCompact(usage, { enabled: true, threshold_tokens: 800_000 }, 107_000)).toBe(false);
    expect(shouldCompact(usage, { enabled: true, threshold_tokens: 800_000 }, 810_000)).toBe(true);
  });

  test("measured context can trip even when the result carried no usage", () => {
    expect(shouldCompact(undefined, CFG_ON, 400_001)).toBe(true);
    expect(shouldCompact(undefined, CFG_ON, 0)).toBe(false);
  });
});

describe("StateStore markCompacted", () => {
  function tempStore() {
    const dir = mkdtempSync(join(tmpdir(), "compact-"));
    const state = new StateStore(dir);
    return {
      state,
      cleanup: () => {
        state.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("starts at 0; markCompacted bumps the boundary", () => {
    const { state, cleanup } = tempStore();
    try {
      expect(state.getLastCompactAtMs("imessage:dm:+1")).toBe(0);
      const before = Date.now();
      state.markCompacted("imessage:dm:+1");
      const stamped = state.getLastCompactAtMs("imessage:dm:+1");
      expect(stamped).toBeGreaterThanOrEqual(before);
    } finally {
      cleanup();
    }
  });

  test("markCompacted is idempotent (latest wins)", () => {
    const { state, cleanup } = tempStore();
    try {
      state.markCompacted("imessage:dm:+1");
      const first = state.getLastCompactAtMs("imessage:dm:+1");
      // small delay so timestamps differ
      const target = Date.now() + 5;
      while (Date.now() < target) {
        /* spin */
      }
      state.markCompacted("imessage:dm:+1");
      const second = state.getLastCompactAtMs("imessage:dm:+1");
      expect(second).toBeGreaterThanOrEqual(first);
    } finally {
      cleanup();
    }
  });
});
