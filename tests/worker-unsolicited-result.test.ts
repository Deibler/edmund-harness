/**
 * A resumed CLI can print a result for a turn it started by itself before it
 * reads our message. On 2026-09-25 the worker took that empty result as the
 * answer to a DM's message; the model went on working untracked and the
 * memory governor evicted the "idle" worker mid-render. The fake CLI replays
 * the stream the real one printed (tests/fixtures/fake-claude-resume.ts).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, isUnsolicitedResult, stampTurnUuid } from "../src/claude/worker.ts";

const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
writeFileSync(
  join(bin, "claude"),
  `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures/fake-claude-resume.ts")}" "$@"\n`,
);
chmodSync(join(bin, "claude"), 0o755);
afterAll(() => rmSync(bin, { recursive: true, force: true }));

const user = (text: string) =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;

function worker(argv: string[]) {
  return new Worker({
    argv: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", ...argv],
    env: { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}` },
    cwd: bin,
    perTurnIdleMs: 3_000,
    sessionKey: "test:unsolicited",
  });
}

describe("a result for a turn the CLI started itself", () => {
  test("is not taken as the answer to our message", async () => {
    const w = worker(["--replay-user-messages", "--resume", "fake-session"]);
    try {
      const r = await w.turn({ stdinPayload: user("hello") });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.reply).toBe("echo: hello");
      const r2 = await w.turn({ stdinPayload: user("again") });
      expect(r2.ok && r2.reply).toBe("echo: again");
    } finally {
      await w.shutdown("test done");
    }
  });

  test("a /compact still completes: its echo comes before its num_turns 0 result", async () => {
    const w = worker(["--replay-user-messages", "--resume", "fake-session"]);
    try {
      expect((await w.turn({ stdinPayload: user("hello") })).ok).toBe(true);
      const c = await w.compact();
      expect(c.ok).toBe(true);
    } finally {
      await w.shutdown("test done");
    }
  });

  test("the rule itself", () => {
    expect(isUnsolicitedResult({ num_turns: 0 }, false)).toBe(true);
    expect(isUnsolicitedResult({ num_turns: 0 }, true)).toBe(false);
    expect(isUnsolicitedResult({ num_turns: 1 }, false)).toBe(false);
    expect(isUnsolicitedResult({ num_turns: 0, is_error: true }, false)).toBe(false);
    const { payload, uuid } = stampTurnUuid(user("x"));
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(payload).uuid).toBe(uuid);
    expect(stampTurnUuid("plain text prompt")).toEqual({
      payload: "plain text prompt",
      uuid: null,
    });
  });

  test("the harness asks the CLI for the echo whenever it writes stream-json", () => {
    const runner = readFileSync(join(import.meta.dir, "../src/claude/runner.ts"), "utf8");
    expect(runner).toContain('...(useStreamJsonInput ? ["--replay-user-messages"] : [])');
    expect(runner).toContain("proc.stdin.end(stamped.payload)");
  });
});
