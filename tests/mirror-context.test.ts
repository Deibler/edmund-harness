import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorEnvelopeBlock } from "../integrations/mirror/src/context.ts";
import { buildSystemPrompt } from "../src/claude/system-prompt.ts";
import type { Config } from "../src/config/config.ts";

describe("Mirror tool invocation guidance", () => {
  test("marks bare MCP catalog names as non-callable", () => {
    const prompt = buildSystemPrompt({
      senderLabel: "Mirror user",
      senderHandle: null,
      isGroup: false,
      sandboxPath: "/tmp/edmund-mirror-test",
      radarOmegaEnabled: false,
    });

    expect(prompt).toContain(
      "Bare catalog names are descriptive shorthand only and are NOT callable",
    );
    expect(prompt).toContain("mcp__edmund-harness__<name>");
    expect(prompt).not.toContain("alias-resolves bare names");
  });

  test("gives the Mirror channel exact fully qualified tool identifiers", () => {
    const root = mkdtempSync(join(tmpdir(), "edmund-mirror-context-"));
    try {
      const block = mirrorEnvelopeBlock({
        paths: { data_dir: root },
        mirror: { default_ttl_seconds: 300 },
      } as Config);

      expect(block).toContain("Bare names are descriptions, not callable aliases");
      expect(block).toContain("mcp__edmund-harness__render_mirror_content");
      expect(block).toContain("mcp__edmund-harness__list_mirror_content");
      expect(block).toContain("mcp__edmund-harness__speak_on_mirror");
      expect(block).toContain("mcp__edmund-harness__send_attachment");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
