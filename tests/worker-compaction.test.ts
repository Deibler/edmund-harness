/**
 * The CLI compacts a conversation by itself when it nears its auto-compact
 * window, mid-turn. Until 2026-10-29 the worker ignored the compact_boundary
 * event: the turn reported its pre-compaction size, the harness compacted the
 * freshly compacted conversation again (31 of 60 harness compactions in one
 * session ran on a context already under 190k), and recall never learned
 * where the model's sight ended. The fake CLI replays the stream CLI 2.1.312
 * printed (tests/fixtures/fake-claude-autocompact.ts).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPACT_INSTRUCTIONS,
  type CompactionEvent,
  compactionFromEvent,
  shouldCompact,
} from "../src/claude/auto-compact.ts";
import { Worker } from "../src/claude/worker.ts";
import { StateStore } from "../src/sessions/store.ts";

const bin = mkdtempSync(join(tmpdir(), "fake-claude-ac-"));
writeFileSync(
  join(bin, "claude"),
  `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures/fake-claude-autocompact.ts")}" "$@"\n`,
);
chmodSync(join(bin, "claude"), 0o755);
afterAll(() => rmSync(bin, { recursive: true, force: true }));

const user = (text: string) =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
const THRESHOLD = { enabled: true, threshold_tokens: 200_000 };

function worker(argv: string[] = []) {
  return new Worker({
    argv: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", ...argv],
    env: { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}` },
    cwd: bin,
    perTurnIdleMs: 3_000,
    sessionKey: "test:autocompact",
  });
}

describe("a turn the CLI compacted by itself", () => {
  test("reports the context after the compaction, not the call before it", async () => {
    const w = worker();
    const seen: CompactionEvent[] = [];
    try {
      const r = await w.turn({ stdinPayload: user("go"), onCompaction: (c) => seen.push(c) });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.contextTokens).toBe(30_000);
      expect(r.compactions.map((c) => c.trigger)).toEqual(["auto"]);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.preTokens).toBe(240_000);
      expect(seen[0]!.postTokens).toBe(18_000);
      // The harness must not compact it again.
      expect(shouldCompact(r.usage, THRESHOLD, r.contextTokens, r.compactions.length > 0)).toBe(
        false,
      );
    } finally {
      await w.shutdown("test done");
    }
  });

  test("with no call after the boundary, falls back to post_tokens, never the usage totals", async () => {
    const w = worker(["--no-call-after"]);
    try {
      const r = await w.turn({ stdinPayload: user("go") });
      expect(r.ok && r.contextTokens).toBe(18_000);
      if (r.ok) expect(shouldCompact(r.usage, THRESHOLD, r.contextTokens, true)).toBe(false);
    } finally {
      await w.shutdown("test done");
    }
  });

  test("with neither post_tokens nor a later call, nothing is measured and nothing trips", async () => {
    const w = worker(["--no-call-after", "--no-post-tokens"]);
    try {
      const r = await w.turn({ stdinPayload: user("go") });
      expect(r.ok && r.contextTokens).toBe(0);
      // The result's usage sums 270k across the turn: a fallback to it is
      // exactly the double compaction this guards against.
      if (r.ok) expect(shouldCompact(r.usage, THRESHOLD, r.contextTokens, true)).toBe(false);
    } finally {
      await w.shutdown("test done");
    }
  });
});

describe("the harness's own /compact", () => {
  test("tells the summary to keep the person's words and what was sent", async () => {
    const w = worker(["--echo-compact", "--replay-user-messages"]);
    try {
      const r = await w.compact();
      expect(r.ok && r.reply).toBe(`/compact ${COMPACT_INSTRUCTIONS}`);
      expect(COMPACT_INSTRUCTIONS).toContain("own words");
      expect(COMPACT_INSTRUCTIONS).toContain("exact final text of anything sent");
    } finally {
      await w.shutdown("test done");
    }
  });
});

describe("compactionFromEvent", () => {
  test("reads the boundary the CLI prints and ignores everything else", () => {
    const c = compactionFromEvent(
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 3651, post_tokens: 1289 },
      },
      42,
    );
    expect(c).toEqual({ trigger: "manual", preTokens: 3651, postTokens: 1289, atMs: 42 });
    expect(
      compactionFromEvent({ type: "system", subtype: "status", status: "compacting" }),
    ).toBeNull();
    expect(compactionFromEvent({ type: "system", subtype: "init" })).toBeNull();
  });
});

describe("markCompacted", () => {
  test("stamps the boundary's own time and never moves it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-state-"));
    const state = new StateStore(dir);
    try {
      state.markCompacted("dm:+15550000001" as never, 2_000);
      state.markCompacted("dm:+15550000001" as never, 1_000);
      expect(state.getLastCompactAtMs("dm:+15550000001" as never)).toBe(2_000);
    } finally {
      state.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("both stream parsers handle the boundary", () => {
  // runProcess (the pool-off path) has its own parser; a guard taken on one
  // path is not a guard.
  test("runner.ts runProcess parses it and resets the per-call max", () => {
    const src = readFileSync(join(import.meta.dir, "../src/claude/runner.ts"), "utf8");
    expect(src).toContain('evt.subtype === "compact_boundary"');
    expect(src).toContain("maxCallContextTokens = contextAfterCompaction(c)");
    expect(src).toContain("onCompaction: compactionStamper(input.sessionKey, store)");
  });
});
