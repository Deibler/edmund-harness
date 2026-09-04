import { describe, expect, test } from "bun:test";
import {
  MAX_PRINCIPLES,
  principlesDerivedAt,
  readPrinciples,
  renderPrinciples,
} from "../src/persona/principles.ts";
import {
  CONSOLIDATE_AFTER_NEW_BULLETS,
  CONSOLIDATION_PROMPT,
  countObservations,
  parseConsolidation,
  shouldConsolidate,
} from "../src/persona/consolidate.ts";

/**
 * A person file is an append-only log and is good at that. What it cannot do
 * is become judgment: three separate entries circled "his own cut always
 * ships" without ever becoming that rule. Observations reach a reply only
 * through semantic recall, so the ~64% of turns that are short reactions get
 * none of them and read generically. Principles are small enough to sit in
 * the prompt permanently and therefore shape every reply.
 */

const file = [
  "# +15551234567",
  "",
  "## Who They Are",
  "- **2026-08-01** — a fact",
  "- **2026-08-02** — another fact",
  "",
  "## Open Items",
  "- **2026-08-03** — a third",
].join("\n");

describe("principles section", () => {
  test("round-trips rules and their evidence", () => {
    const rendered = renderPrinciples(
      [{ rule: "His cut ships — give the note, skip the recut.", evidence: ["2026-08-18", "2026-08-25"] }],
      42,
    );
    const back = readPrinciples(rendered);
    expect(back).toHaveLength(1);
    expect(back[0]!.rule).toBe("His cut ships — give the note, skip the recut.");
    expect(back[0]!.evidence).toEqual(["2026-08-18", "2026-08-25"]);
  });

  test("the derivation point is stamped so the trigger cannot drift from the file", () => {
    expect(principlesDerivedAt(renderPrinciples([{ rule: "a rule here", evidence: [] }], 105))).toBe(105);
    expect(principlesDerivedAt("no section at all")).toBe(0);
  });

  test("the cap is small — this is read on every turn", () => {
    expect(MAX_PRINCIPLES).toBeLessThanOrEqual(10);
    const many = Array.from({ length: 30 }, (_, i) => ({ rule: `rule number ${i}`, evidence: [] }));
    expect(readPrinciples(renderPrinciples(many, 0))).toHaveLength(MAX_PRINCIPLES);
  });

  test("reading a file that has no principles yet is empty, not an error", () => {
    expect(readPrinciples(file)).toEqual([]);
  });
});

describe("consolidation trigger", () => {
  test("counts dated observations", () => {
    expect(countObservations(file)).toBe(3);
  });

  test("fires only once enough has accumulated since the last pass", () => {
    const fresh = `${renderPrinciples([{ rule: "some standing rule", evidence: [] }], 3)}\n${file}`;
    expect(shouldConsolidate(fresh)).toBeFalse();
    const grown = [
      renderPrinciples([{ rule: "some standing rule", evidence: [] }], 3),
      ...Array.from(
        { length: CONSOLIDATE_AFTER_NEW_BULLETS + 3 },
        (_, i) => `- **2026-08-${String((i % 28) + 1).padStart(2, "0")}** — obs ${i}`,
      ),
    ].join("\n");
    expect(shouldConsolidate(grown)).toBeTrue();
  });
});

describe("consolidation output", () => {
  test("parses rules with evidence and drops malformed ones", () => {
    const r = parseConsolidation(
      `noise {"principles":[{"rule":"Base is the limiter, not speed.","evidence":["2026-08-20","bad"]},{"rule":"x"}],"revised":"merged two"}`,
    );
    expect(r).not.toBeNull();
    expect(r!.principles).toHaveLength(1);
    expect(r!.principles[0]!.evidence).toEqual(["2026-08-20"]);
    expect(r!.revised).toBe("merged two");
  });

  test("an empty or unparseable result does not overwrite standing principles", () => {
    expect(parseConsolidation("not json")).toBeNull();
    expect(parseConsolidation('{"principles":[]}')).toBeNull();
  });

  test("the prompt asks for rejections, not just what works", () => {
    // A list of only what someone likes is what makes an assistant agreeable
    // and useless — this is the structural guard against the yes-man failure.
    expect(CONSOLIDATION_PROMPT).toMatch(/REJECTIONS ARE PRINCIPLES TOO/);
    expect(CONSOLIDATION_PROMPT).toMatch(/not followed/i);
    // And it must demand revision, or it becomes a second append-only log.
    expect(CONSOLIDATION_PROMPT).toMatch(/CONTRADICTS/);
    expect(CONSOLIDATION_PROMPT).toMatch(/Do not simply re-emit/i);
  });
});
