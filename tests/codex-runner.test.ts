import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexMcpConfigArgs } from "../src/codex/config.ts";
import {
  MIN_CODEX_CLI_VERSION,
  compareVersions,
  parseCodexVersion,
} from "../src/codex/executable.ts";
import { liveContextFromRollout, rolloutPathForThread } from "../src/codex/rollout.ts";
import {
  buildCodexExecArgs,
  codexToolIdentifiers,
  estimateThreadContext,
  parseCodexJsonLine,
} from "../src/codex/runner.ts";

const BASE = {
  model: "gpt-5.6",
  effort: "high" as const,
  systemPrompt: "Be Edmund.\nKeep continuity.",
  mcpConfig: '{"mcpServers":{}}',
  guest: false,
};

describe("Codex exec arguments", () => {
  test("builds an isolated persistent cold turn", () => {
    const args = buildCodexExecArgs(BASE);
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("resume");
    expect(args).not.toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args.at(-1)).toBe("-");
    expect(args.join("\n")).toContain("developer_instructions=");
    expect(args.join("\n")).toContain("Be Edmund");
  });

  test("non-guest turns get the same trust as Claude's bypassPermissions", () => {
    // The first live day ran workspace-write here; every session was confined
    // to its own sandbox directory and mirror pushes / skills failed. The two
    // CLIs must hold the same keys.
    const args = buildCodexExecArgs(BASE);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.join("\n")).not.toContain("sandbox_mode=");
  });

  test("resumes only a Codex thread id and keeps stdin as the prompt", () => {
    const args = buildCodexExecArgs({ ...BASE, resumeSessionId: "codex-thread-123" });
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args.at(-2)).toBe("codex-thread-123");
    expect(args.at(-1)).toBe("-");
  });

  test("uses the strict no-filesystem guest profile", () => {
    const args = buildCodexExecArgs({ ...BASE, guest: true });
    const rendered = args.join("\n");
    expect(rendered).toContain('default_permissions="edmund_guest"');
    expect(rendered).toContain('permissions.edmund_guest.filesystem={":minimal"="read"}');
    expect(rendered).toContain("permissions.edmund_guest.network.enabled=false");
    expect(rendered).not.toContain("sandbox_mode=");
    // A guest run must never get the unsandboxed bypass.
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("maps max effort to Codex's xhigh ceiling", () => {
    const args = buildCodexExecArgs({ ...BASE, effort: "max" });
    expect(args).toContain('model_reasoning_effort="xhigh"');
  });

  test("passes an explicit model context window to Codex", () => {
    const args = buildCodexExecArgs({ ...BASE, contextWindowTokens: 272_000 });
    expect(args).toContain("model_context_window=272000");
  });
});

describe("Codex executable compatibility", () => {
  test("parses installed CLI version output", () => {
    expect(parseCodexVersion("codex-cli 0.147.0")).toEqual([0, 147, 0]);
    expect(parseCodexVersion("unexpected output")).toBeNull();
  });

  test("compares the minimum supported version numerically", () => {
    const minimum = parseCodexVersion(MIN_CODEX_CLI_VERSION)!;
    expect(compareVersions([0, 147, 0], minimum)).toBe(0);
    expect(compareVersions([0, 92, 0], minimum)).toBeLessThan(0);
    expect(compareVersions([1, 0, 0], minimum)).toBeGreaterThan(0);
  });
});

describe("Codex MCP translation", () => {
  test("translates stdio servers and forwards harness env explicitly", () => {
    const [, config] = codexMcpConfigArgs(
      JSON.stringify({
        mcpServers: {
          "edmund-harness": {
            command: "/opt/homebrew/bin/bun",
            args: ["/repo/src/mcp/server.ts"],
            env: { FIXED: "value" },
          },
        },
      }),
    );
    expect(config).toContain('"edmund-harness"');
    expect(config).toContain('"command" = "/opt/homebrew/bin/bun"');
    expect(config).toContain("EDMUND_SESSION_KEY");
    expect(config).toContain("EDMUND_BRIDGE_SOCK");
    expect(config).toContain('"default_tools_approval_mode" = "approve"');
    expect(config).toContain('"required" = true');
  });

  test("pre-approves only first-party local servers", () => {
    // Exec mode cannot answer approval prompts, so `auto` cancels every
    // state-changing call — but that pre-approval is a trust decision, and
    // it stops at the server the harness itself owns.
    const [, config] = codexMcpConfigArgs(
      JSON.stringify({
        mcpServers: {
          "edmund-harness": { command: "/opt/homebrew/bin/bun", args: ["/repo/server.ts"] },
          ghost: { command: "/opt/homebrew/bin/bun", args: ["/repo/ghost.ts"] },
          "third-party": { command: "/opt/homebrew/bin/bun", args: ["/repo/third.ts"] },
        },
      }),
    );
    expect(config).toMatch(/"edmund-harness" = \{[^}]*"default_tools_approval_mode" = "approve"/);
    expect(config).toMatch(/"ghost" = \{[^}]*"default_tools_approval_mode" = "approve"/);
    expect(config).toMatch(/"ghost" = \{[^}]*"required" = true/);
    expect(config).toMatch(/"third-party" = \{[^}]*"default_tools_approval_mode" = "auto"/);
    expect(config).not.toMatch(/"third-party" = \{[^}]*"approve"/);
    expect(config).toMatch(/"third-party" = \{[^}]*"required" = false/);
  });

  test("rejects malformed provider config before spawning", () => {
    expect(() => codexMcpConfigArgs("not json")).toThrow("invalid MCP config for Codex");
    expect(() => codexMcpConfigArgs(JSON.stringify({ mcpServers: { broken: {} } }))).toThrow(
      'MCP server "broken" has neither command nor url',
    );
  });
});

describe("Codex JSONL parser", () => {
  test("parses native events without accepting malformed lines", () => {
    expect(parseCodexJsonLine('{"type":"thread.started","thread_id":"abc"}')).toEqual({
      type: "thread.started",
      thread_id: "abc",
    });
    expect(parseCodexJsonLine("{broken")).toBeNull();
    expect(parseCodexJsonLine("plain text")).toBeNull();
  });
});

describe("Codex thread context", () => {
  test("fallback estimate divides cumulative input by request count", () => {
    // Only used when the rollout is unreadable. Deliberately errs high for
    // old threads (cumulative numerator) — over-anchoring beats unbounded.
    expect(estimateThreadContext({ input_tokens: 1_312_413 }, 4)).toBe(262_483);
    expect(estimateThreadContext({ input_tokens: 49_428 }, 0)).toBe(49_428);
    expect(estimateThreadContext({}, 3)).toBe(0);
  });

  test("reads the live context from the newest rollout's last token_count", () => {
    const root = join(tmpdir(), `codex-rollout-${process.pid}`);
    const day = join(root, "2026", "08", "11");
    mkdirSync(day, { recursive: true });
    const path = join(day, "rollout-2026-08-11T15-54-34-thread-abc.jsonl");
    const rows = [
      { type: "session_meta", payload: { id: "thread-abc" } },
      {
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50_441 } } },
      },
      { type: "response_item", payload: { type: "message", content: [] } },
      {
        type: "event_msg",
        // The real shape observed 2026-08-11: cumulative 9M, live 199,773.
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 9_025_376 },
            last_token_usage: { input_tokens: 199_773 },
          },
        },
      },
      { type: "event_msg", payload: { type: "task_complete" } },
    ];
    writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    try {
      expect(rolloutPathForThread("thread-abc", root)).toBe(path);
      expect(rolloutPathForThread("thread-missing", root)).toBeNull();
      expect(liveContextFromRollout(path)).toBe(199_773);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Codex tool identifier rewrite", () => {
  test("normalizes hyphenated server names the way Codex's runtime does", () => {
    // Live day: the prompt taught `mcp__edmund-harness__*` but the runtime
    // exposes `mcp__edmund_harness__*`; the model probed ALL_TOOLS five
    // times per thread rediscovering that.
    expect(codexToolIdentifiers("call `mcp__edmund-harness__send_attachment` then rest")).toContain(
      "mcp__edmund_harness__send_attachment",
    );
    // Unhyphenated identifiers and prose stay untouched.
    const untouched = "auto-attach via mcp__radaromega__get_warnings, self-heal";
    expect(codexToolIdentifiers(untouched)).toBe(untouched);
  });

  test("is applied to the developer instructions in exec args", () => {
    const args = buildCodexExecArgs({
      ...BASE,
      systemPrompt: "Use `mcp__edmund-harness__send_message` for texts.",
    });
    const rendered = args.join("\n");
    expect(rendered).toContain("mcp__edmund_harness__send_message");
    expect(rendered).not.toContain("mcp__edmund-harness__send_message");
  });
});
