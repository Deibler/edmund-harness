/**
 * Pure tests for the deep-research planner + reducer helpers. The
 * Haiku spawn is not exercised here — only the parser and the
 * heuristic fallback.
 */
import { describe, expect, test } from "bun:test";
import { DEPTH_FANOUT, parsePlannerOutput, planHeuristic } from "../src/research/planner.ts";
import {
  buildResearcherTask,
  buildSynthesizerTask,
  extractUrls,
  formatSpawnReturn,
} from "../src/research/reducer.ts";

describe("planHeuristic", () => {
  test("returns exactly DEPTH_FANOUT entries", () => {
    expect(planHeuristic("what is X", "quick").length).toBe(DEPTH_FANOUT.quick);
    expect(planHeuristic("what is X", "standard").length).toBe(DEPTH_FANOUT.standard);
    expect(planHeuristic("what is X", "thorough").length).toBe(DEPTH_FANOUT.thorough);
  });

  test("every sub-query mentions the original question", () => {
    const queries = planHeuristic("agentic coding in 2026", "standard");
    for (const q of queries) {
      expect(q.toLowerCase()).toContain("agentic coding in 2026");
    }
  });

  test("sub-queries are distinct", () => {
    const queries = planHeuristic("topic", "thorough");
    const unique = new Set(queries);
    expect(unique.size).toBe(queries.length);
  });
});

describe("parsePlannerOutput", () => {
  test("strict JSON", () => {
    const r = parsePlannerOutput('{"queries":["a","b","c"]}');
    expect(r).toEqual(["a", "b", "c"]);
  });

  test("fenced JSON", () => {
    const raw = 'Here you go:\n```json\n{"queries":["a","b"]}\n```\nDone.';
    expect(parsePlannerOutput(raw)).toEqual(["a", "b"]);
  });

  test("bare-line fallback", () => {
    const raw = `- first sub-query about X
- second sub-query about Y
- third sub-query about Z`;
    const r = parsePlannerOutput(raw);
    expect(r.length).toBe(3);
    expect(r[0]).toContain("first sub-query");
  });

  test("numbered-list fallback", () => {
    const raw = `1. overview of foo
2. recent news on foo
3. critiques of foo`;
    const r = parsePlannerOutput(raw);
    expect(r.length).toBe(3);
    expect(r[1]).toBe("recent news on foo");
  });

  test("empties on malformed input", () => {
    expect(parsePlannerOutput("nope")).toEqual([]);
    expect(parsePlannerOutput("")).toEqual([]);
  });

  test("filters out empty strings in JSON array", () => {
    const r = parsePlannerOutput('{"queries":["a","","b"]}');
    expect(r).toEqual(["a", "b"]);
  });

  test("rejects non-string entries", () => {
    const r = parsePlannerOutput('{"queries":["a", 42, "b"]}');
    expect(r).toEqual(["a", "b"]);
  });
});

describe("reducer task strings", () => {
  test("researcher task references the sub-query and shared dir", () => {
    const t = buildResearcherTask("what is Q", "/shared");
    expect(t).toContain("what is Q");
    expect(t).toContain("/shared/finding-");
  });

  test("synthesizer task references question + fanout", () => {
    const t = buildSynthesizerTask("research X", "/shared", 4);
    expect(t).toContain("research X");
    // Post-sequencing wording (2026-07-28): the synthesizer spawns AFTER
    // the fan-out settles, so it's told the researchers already finished
    // rather than to wait for "4 sibling researchers".
    expect(t).toContain("The 4 researchers have already finished");
    expect(t).toContain("/shared/brief.md");
    expect(t).toContain("/shared/summary.txt");
  });

  test("formatSpawnReturn contains team id, fanout, queries", () => {
    const out = formatSpawnReturn({
      question: "the question",
      teamId: "team_abc",
      fanout: 2,
      sharedDir: "/s",
      plannerVia: "haiku",
      queries: ["q1", "q2"],
    });
    expect(out).toContain("team_abc");
    expect(out).toContain("fanout=2");
    expect(out).toContain("planner=haiku");
    expect(out).toContain("q1");
    expect(out).toContain("q2");
    expect(out).toContain("brief.md");
  });
});

describe("extractUrls", () => {
  test("dedupes URLs", () => {
    const md = `see https://a.com/x and also https://a.com/x and https://b.com`;
    expect(extractUrls(md)).toEqual(["https://a.com/x", "https://b.com"]);
  });

  test("strips trailing punctuation", () => {
    const md = `https://a.com/x), and https://b.com.`;
    expect(extractUrls(md)).toEqual(["https://a.com/x", "https://b.com"]);
  });

  test("ignores non-http schemes", () => {
    const md = `ftp://x.com is not in scope, https://y.com is`;
    expect(extractUrls(md)).toEqual(["https://y.com"]);
  });
});
