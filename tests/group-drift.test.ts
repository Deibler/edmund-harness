import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONSOLIDATION_PROMPT, GROUP_CONSOLIDATION_PROMPT } from "../src/persona/consolidate.ts";
import { renderPrinciples } from "../src/persona/principles.ts";

/**
 * A group's register is contagious, and consolidation is the mechanism that
 * makes things permanent. That combination is dangerous: in the five-person
 * chat this was built for, Edmund misread a tapback aimed at someone else,
 * answered the wrong person sharply, escalated when challenged, sulked, and
 * when told he was being sassy replied "guilty, it's the one setting I don't
 * have a slider for" — disclaiming a choice he made.
 *
 * A pass that only asked "what works in this room" would read that and write
 * down that the room trades insults. Distilling a drift turns a bad afternoon
 * into a personality. These tests pin the properties that stop it.
 */
describe("group consolidation cannot launder drift into doctrine", () => {
  test("it separates how the room works from how Edmund behaves", () => {
    expect(GROUP_CONSOLIDATION_PROMPT).toMatch(/HOW THE ROOM WORKS — descriptive/);
    expect(GROUP_CONSOLIDATION_PROMPT).toMatch(/HOW I BEHAVE HERE — prescriptive/);
  });

  test("conduct is derived against his own character, NOT the room's register", () => {
    const flat = GROUP_CONSOLIDATION_PROMPT.replace(/\s+/g, " ");
    expect(flat).toMatch(/NOT against the room's register/);
    expect(flat).toMatch(/matching it is not automatically correct/);
  });

  test("a drift found is a correction to make, never a rule to keep", () => {
    const flat = GROUP_CONSOLIDATION_PROMPT.replace(/\s+/g, " ");
    expect(flat).toMatch(/is NOT a principle to keep/);
    expect(flat).toMatch(/It is a principle to correct/);
  });

  test("it names the specific failures seen: escalation, sulking, disclaiming tone", () => {
    const flat = GROUP_CONSOLIDATION_PROMPT.replace(/\s+/g, " ");
    for (const probe of [
      /retaliate, sulk/,
      /treat a reaction or a joke as an attack/,
      /disclaim responsibility for my own tone/,
    ]) {
      expect(flat).toMatch(probe);
    }
  });

  test("it guards BOTH failure directions — hostility and yes-man", () => {
    // The prompt is hard-wrapped, so match across newlines rather than
    // asserting on a line shape that reformatting would break.
    const flat = GROUP_CONSOLIDATION_PROMPT.replace(/\s+/g, " ");
    // Warmth yes, temperature no.
    expect(flat).toMatch(/Match the room's warmth, never its temperature/);
    // And the opposite: agreeing because the room is easy on you.
    expect(flat).toMatch(/do not be a yes-man because the room is easy/);
    expect(flat).toMatch(/without either folding or hardening/);
  });

  test("the DM prompt is NOT reused for groups — they answer different questions", () => {
    expect(GROUP_CONSOLIDATION_PROMPT).not.toBe(CONSOLIDATION_PROMPT);
    // The DM prompt has no notion of the agent's own drift, which is the
    // whole reason a group needs its own.
    expect(CONSOLIDATION_PROMPT).not.toMatch(/HOW I BEHAVE HERE/);
  });

  test("a group's principles block says it is about the room, not a person", () => {
    const g = renderPrinciples([{ rule: "a standing rule", evidence: [] }], 5, "group");
    expect(g).toMatch(/how this room works and how I behave in it/);
    const p = renderPrinciples([{ rule: "a standing rule", evidence: [] }], 5, "person");
    expect(p).toMatch(/working with this person/);
  });
});

describe("tapback attribution", () => {
  test("history names whose message a reaction targeted", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/channels/history-format.ts"), "utf8");
    // The spiral began because a reaction to ANOTHER member's message quoted a
    // line starting "Edmund, …" and was read as aimed at him.
    expect(src).toContain("reacting to YOUR message");
    expect(src).toMatch(/reacting to \$\{.*\}'s message, not yours/);
  });

  test("the history query resolves the tapback's target author", () => {
    const sql = readFileSync(join(import.meta.dir, "..", "src/imessage/history.ts"), "utf8");
    expect(sql).toMatch(/associated_message_type BETWEEN 2000 AND 3099/);
    // The guid carries a protocol prefix; without stripping it the join finds
    // nothing and every tapback looks unattributed again.
    expect(sql).toMatch(/replace\(replace\(m\.associated_message_guid/);
  });
});
