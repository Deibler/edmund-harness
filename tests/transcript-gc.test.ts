/**
 * Workers run with the CLI's transcript GC, so a long conversation's file is
 * cut back to its live part at each compaction instead of growing without
 * bound (1.3 GB for the operator's DM by 2026-10-29). It must reach the
 * process environment: the CLI ignores it in a settings `env` block.
 */
import { describe, expect, test } from "bun:test";
import { toolEnv } from "../src/claude/mcp-config.ts";
import { ConfigSchema } from "../src/config/config.ts";

describe("worker environment", () => {
  test("turns on the CLI's transcript GC", () => {
    const config = ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} });
    const env = toolEnv(config, "imessage:dm:+15550100051" as never, "/tmp/sandbox", 0, null);
    expect(env.CLAUDE_CODE_TRANSCRIPT_LOCAL_GC).toBe("1");
  });
});
