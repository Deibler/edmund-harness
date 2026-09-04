import { describe, expect, test } from "bun:test";
import { genId } from "../src/util/ids.ts";

const ID_RE = /^([a-z]+)_\d{8}T\d{6}_[0-9a-f]{6}_[0-9a-z]+$/;

describe("genId", () => {
  test("has the requested prefix and ts + random + counter segments", () => {
    expect(genId("job")).toMatch(ID_RE);
    expect(genId("agent")).toMatch(ID_RE);
    expect(genId("team")).toMatch(ID_RE);
  });

  test("ids are unique across a tight burst (per-process counter guarantees it)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(genId("x"));
    expect(seen.size).toBe(20_000);
  });

  test("are roughly time-ordered: ts segment is non-decreasing in mint order", () => {
    const ts = (s: string) => s.split("_")[1]!;
    const a = ts(genId("a"));
    const b = ts(genId("a"));
    expect(a <= b).toBe(true);
  });

  test("slicing off the prefix leaves a clean body (the old team-id pattern still works)", () => {
    const body = genId("agent").slice("agent_".length);
    expect(body).toMatch(/^\d{8}T\d{6}_[0-9a-f]{6}_[0-9a-z]+$/);
    expect(`team_${body}`).toMatch(ID_RE);
  });
});
