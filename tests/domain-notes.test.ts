import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { domainSlug } from "../src/persona/domains.ts";

/**
 * Person files made Edmund specific about someone; nothing made him expert at
 * anything. His endurance-training knowledge was the base model's plus
 * whatever got searched that morning, and it did not compound — a genuinely
 * good piece of reasoning about why a psoas that flares with mileage is weak
 * rather than tight taught him nothing he would still have in November, and
 * the next runner started from scratch.
 *
 * Following ReasoningBank: store distilled strategy, and mine FAILURES, not
 * only successes. "Told a runner to drop lifting, ignored every time" is worth
 * more than a citation because no article will ever tell you that.
 */
describe("domain notes", () => {
  test("slugs are stable and filesystem-safe", () => {
    expect(domainSlug("Endurance Training")).toBe("endurance-training");
    expect(domainSlug("short-form   content!!")).toBe("short-form-content");
  });

  test("the schema REQUIRES an outcome, so a rejection cannot be omitted", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/mcp/tools/memory.ts"), "utf8");
    expect(src).toContain('"rejected"');
    // Not optional: a note that never says what happened is a citation, which
    // is the thing this layer exists to be better than.
    expect(src).toMatch(/outcome: z\s*\n?\s*\.enum/);
    expect(src).not.toMatch(/outcome:.*optional\(\)/);
  });

  test("the tool asks for failures explicitly", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/mcp/tools/memory.ts"), "utf8");
    expect(src).toMatch(/Record REJECTIONS and FAILURES too/);
  });

  test("domain notes are indexed globally, like SOUL — not scoped to one chat", () => {
    const idx = readFileSync(join(import.meta.dir, "..", "src/memory/indexer.ts"), "utf8");
    expect(idx).toContain('"domains"');
    // Same null-guid global path SOUL uses, or they would only ever surface in
    // the conversation that produced them — which is the failure being fixed.
    expect(idx).toMatch(/kind: "self-file" as const,\s*\n\s*chatGuid: null/);
  });
});
