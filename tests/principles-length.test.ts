/**
 * A count cap cannot bound a list whose entries can grow. From 10-25 to 10-29
 * 2026 the operator's ten operating principles grew from 300-550 characters each to
 * 566-1,377, because every pass folded its new rule into a standing one. The
 * length rules are checked where the list is written, with one retry that
 * names what broke; a second miss keeps the standing list.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSOLIDATION_PROMPT,
  GROUP_CONSOLIDATION_PROMPT,
  consolidatePerson,
} from "../src/persona/consolidate.ts";
import {
  MAX_EVIDENCE_SHOWN,
  MAX_PRINCIPLES,
  MAX_RULE_CHARS,
  principleViolations,
  readPrinciples,
  renderPrinciples,
} from "../src/persona/principles.ts";

const dir = mkdtempSync(join(tmpdir(), "principles-length-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const STANDING = "- Show a rendered mockup before asking for a print yes. _(2026-10-26)_";
function personFile(path: string): void {
  writeFileSync(
    path,
    `# Test Person\n\n## Operating Principles\n_(Derived at 1 observations.)_\n\n${STANDING}\n\n## What I've Learned\n- **2026-10-28** — one\n- **2026-10-29** — two\n`,
  );
}
const rule = (n: number) => `Do the ${n}th thing exactly as asked and nothing else, every time.`;
const folded = Array.from({ length: 6 }, (_, i) => rule(i)).join("; ");
const answer = (rules: string[]) =>
  JSON.stringify({
    principles: rules.map((r) => ({ rule: r, evidence: ["2026-10-29"] })),
    revised: "x",
  });

describe("principleViolations", () => {
  test("flags a rule over the limit", () => {
    expect(principleViolations([{ rule: rule(1), evidence: [] }])).toEqual([]);
    const long = principleViolations([{ rule: folded, evidence: [] }]);
    expect(long[0]).toContain(`limit ${MAX_RULE_CHARS}`);
  });

  test("the caps bound the whole section, so it needs no total of its own", () => {
    const dates = Array.from(
      { length: 17 },
      (_, i) => `2026-10-${String(i + 10).padStart(2, "0")}`,
    );
    const fullest = Array.from({ length: MAX_PRINCIPLES + 3 }, () => ({
      rule: "x".repeat(MAX_RULE_CHARS),
      evidence: dates,
    }));
    const body = renderPrinciples(fullest).split("\n").slice(3).join("\n");
    expect(body.length).toBeLessThan(3_300);
  });

  test("renders only the newest evidence dates", () => {
    const dates = Array.from(
      { length: 12 },
      (_, i) => `2026-10-${String(i + 10).padStart(2, "0")}`,
    );
    const [p] = readPrinciples(renderPrinciples([{ rule: rule(1), evidence: dates }]));
    expect(p!.evidence).toEqual(dates.slice(-MAX_EVIDENCE_SHOWN));
  });
});

describe("consolidatePerson", () => {
  test("a folded answer is retried with what broke, and the retry is written", async () => {
    const path = join(dir, "retry.md");
    personFile(path);
    const prompts: string[] = [];
    const replies = [answer([folded]), answer([rule(1), rule(2)])];
    const r = await consolidatePerson(
      "p",
      async (_s, user) => {
        prompts.push(user);
        return replies.shift() ?? null;
      },
      undefined,
      () => path,
    );
    expect(r.ok).toBeTrue();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("YOUR LAST ANSWER BROKE THE LENGTH RULES");
    expect(readPrinciples(readFileSync(path, "utf8")).map((p) => p.rule)).toEqual([
      rule(1),
      rule(2),
    ]);
  });

  test("a second folded answer keeps the standing list", async () => {
    const path = join(dir, "keep.md");
    personFile(path);
    const before = readFileSync(path, "utf8");
    const r = await consolidatePerson(
      "p",
      async () => answer([folded]),
      undefined,
      () => path,
    );
    expect(r).toEqual({ ok: false, reason: "over the length limits" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("both prompts ask for one rule per principle", () => {
  test("with the limit stated", () => {
    for (const p of [CONSOLIDATION_PROMPT, GROUP_CONSOLIDATION_PROMPT]) {
      expect(p).toContain("ONE RULE PER PRINCIPLE");
      expect(p).toContain(`at most ${MAX_RULE_CHARS} characters`);
      expect(p).toContain("retire the weakest");
    }
  });
});
