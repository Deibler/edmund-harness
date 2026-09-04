import { describe, expect, test } from "bun:test";
import { modelProfileForSession } from "../src/claude/runner.ts";
import {
  activityDetailForTool,
  modelActivityForBlock,
  textDeltaForBlock,
} from "../src/claude/worker.ts";
import type { Config } from "../src/config/config.ts";

describe("model activity projection", () => {
  test("derives Mirror phases from actual streamed content blocks", () => {
    expect(modelActivityForBlock("thinking")).toBe("thinking");
    expect(modelActivityForBlock("tool_use", "mirror_render")).toBe("working");
    expect(modelActivityForBlock("tool_result")).toBe("thinking");
    expect(modelActivityForBlock("text")).toBe("responding");
    expect(modelActivityForBlock("tool_use", "send_message")).toBe("responding");
  });

  test("routes only the Mirror session to Sonnet 5 medium", () => {
    const config = {
      claude: { model: "claude-opus-4-8[1m]", effort: "high" },
      mirror: {
        session_key: "mirror:pi-4",
        model: "claude-sonnet-5[1m]",
        effort: "medium",
      },
      trading: { model: "", effort: "" },
    } as Config;

    expect(modelProfileForSession("mirror:pi-4", config)).toEqual({
      model: "claude-sonnet-5[1m]",
      effort: "medium",
    });
    expect(modelProfileForSession("dm:+15551234567", config)).toEqual({
      model: "claude-opus-4-8[1m]",
      effort: "high",
    });
  });

  test("preserves paragraph boundaries between streamed Claude text blocks", () => {
    expect(textDeltaForBlock("Found it.", false)).toBe("Found it.");
    expect(textDeltaForBlock("Fixed.", true)).toBe("\n\nFixed.");
    expect(textDeltaForBlock("\nAlready separated.", true)).toBe("\nAlready separated.");
  });
});

describe("activity detail", () => {
  // A long turn shows "Working" unchanged for minutes; the detail is what
  // proves it is still moving rather than wedged.
  test("names what MCP-prefixed tools are doing", () => {
    expect(activityDetailForTool("mcp__edmund-harness__web_search")).toBe("searching the web");
    expect(activityDetailForTool("mcp__edmund-harness__render_mirror_content")).toBe(
      "updating the screen",
    );
    expect(activityDetailForTool("mcp__edmund-harness__generate_video")).toBe("making a video");
  });

  test("names built-in tools", () => {
    expect(activityDetailForTool("Bash")).toBe("running a command");
    expect(activityDetailForTool("Read")).toBe("reading files");
    expect(activityDetailForTool("Edit")).toBe("editing files");
  });

  test("falls back rather than showing nothing for an unknown tool", () => {
    expect(activityDetailForTool("some_new_tool")).toBe("working on it");
  });

  test("no tool means no detail", () => {
    expect(activityDetailForTool(undefined)).toBeUndefined();
  });
});
