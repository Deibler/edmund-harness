import { describe, expect, test } from "bun:test";
import { backendForModel, transitionModelSession } from "../src/model/backend.ts";
import { shouldReanchorCodex } from "../src/model/runner.ts";

describe("model backend routing", () => {
  test.each([
    "gpt-5.6",
    "GPT-5.6-luna",
    "chatgpt-latest",
    "o1",
    "o3-mini",
    "o9-preview",
    "codex-mini-latest",
  ])("routes %s through Codex CLI", (model) => {
    expect(backendForModel(model)).toBe("codex");
  });

  test.each(["claude-opus-4-8[1m]", "claude-sonnet-5", "haiku", "company-alias"])(
    "keeps %s on Claude Code for backward compatibility",
    (model) => {
      expect(backendForModel(model)).toBe("claude");
    },
  );
});

describe("provider thread isolation", () => {
  test("preserves a native thread when the provider does not change", () => {
    expect(
      transitionModelSession({ sessionId: "codex-thread", backend: "codex" }, "codex"),
    ).toEqual({ sessionId: "codex-thread", priorBackend: "codex", switched: false });
    expect(
      transitionModelSession({ sessionId: "claude-thread", backend: "claude" }, "claude"),
    ).toEqual({ sessionId: "claude-thread", priorBackend: "claude", switched: false });
  });

  test("drops opaque ids in both switch directions", () => {
    expect(
      transitionModelSession({ sessionId: "claude-thread", backend: "claude" }, "codex"),
    ).toEqual({ sessionId: null, priorBackend: "claude", switched: true });
    expect(
      transitionModelSession({ sessionId: "codex-thread", backend: "codex" }, "claude"),
    ).toEqual({ sessionId: null, priorBackend: "codex", switched: true });
  });

  test("treats untagged legacy ids as Claude, never as Codex", () => {
    expect(
      transitionModelSession({ sessionId: "legacy-claude-id", backend: null }, "codex"),
    ).toEqual({ sessionId: null, priorBackend: "claude", switched: true });
  });
});

describe("Codex context bound", () => {
  const compact = { enabled: true, threshold_tokens: 200_000 };

  test("re-anchors any Codex invocation at the measured threshold", () => {
    expect(
      shouldReanchorCodex(
        {
          ok: true,
          backend: "codex",
          reply: "done",
          claudeSessionId: "codex-thread",
          contextTokens: 200_000,
        },
        compact,
      ),
    ).toBeTrue();
  });

  test("never re-anchors Claude or a disabled policy", () => {
    const result = {
      ok: true as const,
      backend: "claude" as const,
      reply: "done",
      claudeSessionId: "claude-thread",
      contextTokens: 250_000,
    };
    expect(shouldReanchorCodex(result, compact)).toBeFalse();
    expect(
      shouldReanchorCodex(
        { ...result, backend: "codex" },
        { enabled: false, threshold_tokens: 200_000 },
      ),
    ).toBeFalse();
  });
});
