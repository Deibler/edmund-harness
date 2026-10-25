import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/claude/system-prompt.ts";
import { BLIND_CHECK_PROMPT } from "../src/mcp/tools/blind-check.ts";

const prompt = (over: Record<string, unknown> = {}) =>
  buildSystemPrompt({
    senderLabel: "Riley",
    senderHandle: null,
    isGroup: false,
    sandboxPath: "/tmp/edmund-finishing-test",
    radarOmegaEnabled: false,
    ...over,
  });

describe("every turn knows how to finish the job", () => {
  test("a DM prompt carries the finishing rules, not the group ones", () => {
    const p = prompt();
    expect(p).toContain("# Finishing the job");
    expect(p).toContain("**Say what you checked.**");
    expect(p).toContain("**One line on what could go wrong.**");
    expect(p).toContain("`shelve`");
    expect(p).toContain("`blind_check`");
    expect(p).not.toContain("**Coordinate, don't just riff.**");
  });

  test("a group prompt adds the coordinator rules", () => {
    const p = prompt({ isGroup: true, chatGuid: "any;+;chat-finishing-test" });
    expect(p).toContain("**Coordinate, don't just riff.**");
    expect(p).toContain("**Feedback on your own posts is for you,**");
  });

  test("the lens command points at a real list of ordinary lenses", () => {
    const p = prompt();
    const m = p.match(/shuf -n 5 (\S+lenses\.txt)/);
    expect(m).not.toBeNull();
    const path = m![1]!;
    expect(existsSync(path)).toBe(true);
    const lenses = readFileSync(path, "utf8").trim().split("\n");
    expect(lenses.length).toBeGreaterThanOrEqual(100);
    expect(new Set(lenses).size).toBe(lenses.length);
  });

  test("the blind check is told to count, and not told what it is looking at", () => {
    expect(BLIND_CHECK_PROMPT).toContain("You have not been told what it is supposed to be");
    expect(BLIND_CHECK_PROMPT).toMatch(/Count every repeated part/);
  });

  test("the shelf and blind check are real tools for non-guest sessions", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/mcp/server.ts"), "utf8");
    expect(src).toContain("...(guest ? [] : shelfTools(ctx)),");
    expect(src).toContain("...(guest ? [] : blindCheckTools(ctx)),");
  });
});
