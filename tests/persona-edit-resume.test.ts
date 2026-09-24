/**
 * The runner used to log "persona edit detected → cold-spawn this turn" and
 * "fresh session id", then resume the stored session anyway: every one of 636
 * logged events resumed or reused a warm worker. The resume was the right
 * behaviour (the CLI rebuilds the system prompt on every process start, so the
 * edit arrives either way and the conversation survives); the log was wrong.
 * Every resume now goes through resumeIdFor, so "fresh" can only be logged
 * when a fresh session is what actually starts.
 */
import { describe, expect, test } from "bun:test";
import { resumeIdFor } from "../src/claude/runner.ts";

describe("which session a turn resumes", () => {
  test("a stored session is resumed", () => {
    expect(resumeIdFor({ claudeSessionId: "abc" }, false)).toBe("abc");
  });

  test("a fresh session is started only when one is asked for", () => {
    expect(resumeIdFor({ claudeSessionId: "abc" }, true)).toBeNull();
  });

  test("nothing stored means a new session", () => {
    expect(resumeIdFor(null, false)).toBeNull();
    expect(resumeIdFor({ claudeSessionId: null }, false)).toBeNull();
  });
});
