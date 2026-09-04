/**
 * parseOneShotStream — the pure NDJSON parser behind runClaudeOneShot.
 * Every satellite model call (ghost, maintainer, catch-up, planner,
 * pre-screen) depends on this extracting the final text AND the cost the
 * old `--output-format text` path threw away.
 */
import { describe, expect, test } from "bun:test";
import { parseOneShotStream } from "../src/claude/one-shot.ts";

describe("parseOneShotStream", () => {
  test("extracts result text, cost, usage, model, num_turns", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-4-5" }),
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "thinking…" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "the final answer",
        total_cost_usd: 0.0123,
        num_turns: 2,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ].join("\n");
    const f = parseOneShotStream(stdout);
    expect(f.text).toBe("the final answer");
    expect(f.costUsd).toBeCloseTo(0.0123);
    expect(f.model).toBe("claude-haiku-4-5");
    expect(f.numTurns).toBe(2);
    expect(f.usage?.output_tokens).toBe(50);
  });

  test("falls back to last assistant text when result is empty", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "first" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "last words" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: "", total_cost_usd: 0.5 }),
    ].join("\n");
    const f = parseOneShotStream(stdout);
    expect(f.text).toBe("last words");
    expect(f.costUsd).toBe(0.5);
  });

  test("tolerates garbage lines and empty input", () => {
    expect(parseOneShotStream("").text).toBe("");
    const f = parseOneShotStream(
      `not json\n{broken\n${JSON.stringify({ type: "result", result: "ok" })}`,
    );
    expect(f.text).toBe("ok");
    expect(f.costUsd).toBeNull();
  });
});
