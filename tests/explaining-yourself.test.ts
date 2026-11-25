import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTPUT_RULES, buildSystemPrompt } from "../src/claude/system-prompt.ts";

const OWNER = "Dana Example";
const prompt = (over: Record<string, unknown> = {}) =>
  buildSystemPrompt({
    senderLabel: "Riley",
    senderHandle: null,
    isGroup: false,
    sandboxPath: "/tmp/edmund-explaining-test",
    radarOmegaEnabled: false,
    ownerName: OWNER,
    ...over,
  });

/** The output contract as a session receives it, tokens filled. */
const contract = (p: string) => {
  const start = p.indexOf("# Output contract\n");
  expect(start).toBeGreaterThan(-1);
  const end = p.indexOf("\n\n---\n\n", start);
  return p.slice(start, end === -1 ? undefined : end);
};

const RULE = "**Explaining yourself is about you, not about who built you.**";
const lineWith = (needle: string) => OUTPUT_RULES.split("\n").find((l) => l.includes(needle)) ?? "";

describe("the assistant explains itself without naming its operator", () => {
  test("DM, group and guest sessions all carry the rule", () => {
    expect(contract(prompt())).toContain(RULE);
    expect(contract(prompt({ isGroup: true, chatGuid: "any;+;chat-explaining-test" }))).toContain(
      RULE,
    );
    expect(contract(prompt({ guestTier: "vouched" }))).toContain(RULE);
  });

  // The operator's name is something the assistant knows. A line that puts
  // it inside the words to say is how it reached a stranger's phone in full.
  test("the contract states who the operator is once, and never as words to say", () => {
    expect(OUTPUT_RULES.split("{{owner}}").length - 1).toBe(1);
    expect(lineWith("{{owner}}")).toContain("is the operator who built you and runs you");
    expect(lineWith("**Honesty about what you are.**")).not.toContain("{{owner}}");
    expect(lineWith(RULE)).not.toContain("{{owner}}");
    expect(OUTPUT_RULES).not.toMatch(/answer plainly:[^\n]*\{\{owner\}\}/);
    expect(contract(prompt()).split(OWNER).length - 1).toBe(1);
  });

  test("it covers what kind of question this is, introductions and the point-blank ask", () => {
    const rule = lineWith(RULE);
    expect(rule).toContain("how you differ from ChatGPT or any other assistant");
    expect(rule).toContain("When your identity has notes on what you are, they are the answer");
    expect(rule).toContain("Your operator's name stays out of it");
    expect(rule).toContain("Introducing yourself to someone new works the same way");
    expect(rule).toContain("never the full name");
  });

  test("who built you is no longer answered from the are-you-an-AI script", () => {
    expect(lineWith("**Honesty about what you are.**")).not.toContain("who built you");
  });

  // The rule sends the model to notes in its identity. A fresh clone gets
  // its identity from the template, so the template has to have them.
  test("the persona template has the notes the rule points at", () => {
    const template = readFileSync(
      join(import.meta.dir, "..", "persona.example", "IDENTITY.md"),
      "utf8",
    );
    expect(template).toContain("## What I am, when someone asks");
  });
});
