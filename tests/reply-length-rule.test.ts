import { describe, expect, test } from "bun:test";
import { OUTPUT_RULES, buildSystemPrompt } from "../src/claude/system-prompt.ts";

const prompt = (over: Record<string, unknown> = {}) =>
  buildSystemPrompt({
    senderLabel: "Riley",
    senderHandle: null,
    isGroup: false,
    sandboxPath: "/tmp/edmund-reply-length-test",
    radarOmegaEnabled: false,
    ...over,
  });

const RULE = "**They are reading this on a phone, on the go.**";
const lineWith = (needle: string) => OUTPUT_RULES.split("\n").find((l) => l.includes(needle)) ?? "";

describe("replies are sized for someone reading on a phone", () => {
  test("a DM and a group prompt both carry the rule", () => {
    expect(prompt()).toContain(RULE);
    expect(prompt({ isGroup: true, chatGuid: "any;+;chat-reply-length-test" })).toContain(RULE);
  });

  test("it comes before the format limits, where the channel is described", () => {
    const rule = OUTPUT_RULES.indexOf(RULE);
    expect(rule).toBeGreaterThan(OUTPUT_RULES.indexOf("**iMessage is a chat."));
    expect(rule).toBeLessThan(OUTPUT_RULES.indexOf("**HARD LIMITS**"));
  });

  test("it sets a size, names what to leave out, and says when long is right", () => {
    const body = lineWith(RULE);
    expect(body).toContain("one to three sentences");
    expect(body).toContain("What stays out until they ask");
    expect(body).toContain("Go long only when you truly believe this message needs it");
    expect(body).toContain("In a group, shorter still");
  });

  // A cap in lines did not hold: three 300-character paragraphs are three
  // lines. And two caps with two different exceptions is how a contract
  // starts arguing with itself, so each one defers to the rule's.
  test("the size limits count sentences and characters and share one exception", () => {
    expect(OUTPUT_RULES).not.toContain("explicitly asked for depth");
    expect(OUTPUT_RULES).not.toContain("they didn't ask for depth");
    expect(OUTPUT_RULES).not.toMatch(/Target ≤ \d+ lines/);
    const size = lineWith("– Size:");
    expect(size).toContain("Count sentences, not lines");
    expect(size).toContain("on-the-go rule");
    const check = lineWith("– More than ~300 chars");
    expect(check).toContain("on-the-go rule");
  });

  // The example was part of what was measured. One that broke its own rule
  // would teach the long version.
  test("the worked example obeys the size it teaches", () => {
    const quoted = (label: string) => lineWith(label).match(/"(.+)"/)?.[1] ?? "";
    const tooMuch = quoted("    Too much: ");
    const right = quoted("    Right: ");
    expect(right.length).toBeGreaterThan(0);
    expect(right.length).toBeLessThanOrEqual(300);
    expect(right.split(/[.?!]\s/).length).toBeLessThanOrEqual(3);
    expect(tooMuch.length).toBeGreaterThan(right.length * 3);
  });
});
