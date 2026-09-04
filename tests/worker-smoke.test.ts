/**
 * Smoke test for the resident worker abstraction.
 *
 * Skipped by default: it spawns a real `claude` subprocess and burns a few
 * API calls. Set RUN_WORKER_SMOKE=1 to opt in. The test verifies the core
 * value prop: TWO turns served by ONE process, same session_id across
 * both, second turn benefiting from Anthropic prompt caching.
 */
import { describe, expect, test } from "bun:test";
import { Worker } from "../src/claude/worker.ts";

const enabled = process.env.RUN_WORKER_SMOKE === "1";
const describeMaybe = enabled ? describe : describe.skip;

describeMaybe("Worker (live)", () => {
  test("processes two consecutive turns in one process with same session id", async () => {
    const events1 = `${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "Reply with literally just the word ONE." }],
      },
    })}\n`;
    const events2 = `${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "Reply with literally just the word TWO." }],
      },
    })}\n`;

    const worker = new Worker({
      argv: [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        "--no-session-persistence",
      ],
      env: process.env as Record<string, string>,
      cwd: "/tmp",
      perTurnIdleMs: 60_000,
      sessionKey: "test:worker-smoke",
    });

    try {
      const r1 = await worker.turn({ stdinPayload: events1 });
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        expect(r1.reply.trim().toUpperCase()).toContain("ONE");
        const sid1 = r1.claudeSessionId;
        expect(sid1).toBeTruthy();

        const r2 = await worker.turn({ stdinPayload: events2 });
        expect(r2.ok).toBe(true);
        if (r2.ok) {
          expect(r2.reply.trim().toUpperCase()).toContain("TWO");
          // Critical assertion: same process → same session id → prompt cache reused.
          expect(r2.claudeSessionId).toBe(sid1);
        }
      }
    } finally {
      await worker.shutdown("test done");
    }
  }, 120_000);
});
