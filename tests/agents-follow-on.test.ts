/**
 * Team follow-on marker (deep_research's sequenced synthesizer, 2026-07-28).
 *
 * The synthesizer used to spawn CONCURRENTLY with the researchers and poll
 * the shared dir "every ~30s for up to 10 minutes" — a worker paid to
 * sleep. It now spawns from the settle site of the last researcher via an
 * atomically-consumed marker file, so the reduce step starts only when the
 * map step is actually done.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeFollowOnMarker,
  teamSharedDirFor,
  writeFollowOnMarker,
} from "../src/agents/follow-on.ts";
import { buildSynthesizerTask, formatSpawnReturn } from "../src/research/reducer.ts";

const SPEC = {
  role: "synthesizer",
  task: "merge the findings",
  parentSessionKey: "imessage:dm:+15550100001",
  parentSandbox: "/tmp/sandbox",
};

describe("follow-on marker", () => {
  test("consume returns the spec exactly once", () => {
    const dir = mkdtempSync(join(tmpdir(), "followon-"));
    try {
      writeFollowOnMarker(dir, SPEC);
      expect(consumeFollowOnMarker(dir)).toEqual(SPEC);
      // Second settle pass (e.g. after the synthesizer itself finishes)
      // must get nothing — that's what lets the team-done event fire.
      expect(consumeFollowOnMarker(dir)).toBeNull();
      // The claimed marker is kept for debuggability.
      expect(existsSync(join(dir, ".follow-on.json.consumed"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no marker → null (ordinary spawn_team teams are unaffected)", () => {
    const dir = mkdtempSync(join(tmpdir(), "followon-"));
    try {
      expect(consumeFollowOnMarker(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("teamSharedDirFor derives the shared dir from a member sandbox", () => {
    // Layout owned by spawn.ts: member = <parent>/agents/<id>,
    // shared = <parent>/teams/<teamId>/shared.
    expect(teamSharedDirFor("/sb/agents/agent_123", "team_9")).toBe("/sb/teams/team_9/shared");
  });
});

describe("synthesizer sequencing prompts", () => {
  test("synthesizer task assumes findings are complete — no polling", () => {
    const task = buildSynthesizerTask("why is the sky blue?", "/shared", 4);
    expect(task).toContain("already finished");
    expect(task).toContain("do NOT wait or poll");
    expect(task).not.toContain("Poll every");
    expect(task).not.toContain("10 minutes");
  });

  test("spawn return tells the model one event arrives after the synthesizer", () => {
    const out = formatSpawnReturn({
      question: "q",
      teamId: "team_1",
      fanout: 4,
      sharedDir: "/shared",
      plannerVia: "haiku",
      queries: ["a", "b"],
    });
    expect(out).toContain("Do NOT poll");
    expect(out).toContain("synthesizer spawns automatically");
  });
});
