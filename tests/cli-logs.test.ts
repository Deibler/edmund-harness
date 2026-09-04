/**
 * Log-viewer parsing: every producer shape that appears in a real
 * daemon.log must land in the right columns — scope, session (the thread
 * identity), event, fields. Shapes are taken verbatim from 2026-07-30's
 * log, the day the session column was mostly dashes.
 */
import { describe, expect, test } from "bun:test";
import { normalizeSession, parseLine } from "../cli/commands/logs.ts";

const TS = "2026-07-30T18:11:24.395Z";

describe("parseLine — structured daemon lines", () => {
  test("session= field is lifted and shortened", () => {
    const p = parseLine(
      `${TS} [log] [claude-worker] tool_use Bash session=dm:+15550100003 id=toolu_x input_summary="{}"`,
    );
    expect(p.scope).toBe("claude-worker");
    expect(p.session).toBe("dm:+15550100003");
    expect(p.event).toBe("tool_use Bash");
    expect(p.fields).toContain("id=toolu_x");
  });

  test("session-lock lines with a session field fill the thread column", () => {
    const p = parseLine(
      `${TS} [error] [session-lock] no liveness signal — releasing lock; fn() continues in background session=dm:+15550100003 heldMs=660010`,
    );
    expect(p.scope).toBe("session-lock");
    expect(p.session).toBe("dm:+15550100003");
  });

  test("legacy key=imessage:… lines still resolve the session", () => {
    const p = parseLine(
      `${TS} [error] [pipeline] Error: session lock timeout key=imessage:dm:+15550100002 elapsedMs=1`,
    );
    expect(p.session).toBe("dm:+15550100002");
  });

  test("first-token dm:/group: form (inbound/outbound one-liners)", () => {
    const p = parseLine(`${TS} [log] [outbound] dm:+15550100003 → sent  1 chunk`);
    expect(p.scope).toBe("outbound");
    expect(p.session).toBe("dm:+15550100003");
    expect(p.event).toContain("sent");
  });

  test("send-verify chat-spec fields fill the session column without being consumed", () => {
    const p = parseLine(
      `${TS} [error] [send-verify] send landed in our own thread guid=E9015271 intended=any;-;+15550100002 landed=e:bot@example.com`,
    );
    expect(p.scope).toBe("send-verify");
    expect(p.session).toBe("dm:+15550100002");
    expect(p.fields).toContain("intended=any;-;+15550100002");
  });
});

describe("parseLine — subprocess (mcp/agent) lines", () => {
  test("mcp tool call: scope from inner tag, session from the sink prefix", () => {
    const p = parseLine(
      `${TS} [log] mcp[dm:+15550100003] [tool] ✓ send_attachment  dur=65ms reply=sent`,
    );
    expect(p.subprocess).toBe(true);
    expect(p.scope).toBe("tool");
    expect(p.session).toBe("dm:+15550100003");
    expect(p.event).toBe("✓ send_attachment");
    expect(p.fields).toContain("dur=65ms");
  });

  test("mcp tool-specific tag keeps its scope; duplicate session token is consumed", () => {
    const p = parseLine(
      `${TS} [error] mcp[dm:+15550100003] [send_attachment] imessage:dm:+15550100003 FAILED: misdelivered: chat routes to self`,
    );
    expect(p.scope).toBe("send_attachment");
    expect(p.session).toBe("dm:+15550100003");
    expect(p.event).toContain("FAILED: misdelivered");
    expect(p.event).not.toContain("imessage:");
  });

  test("agent subprocess prefix becomes an agent: thread", () => {
    const p = parseLine(`${TS} [log] agent[abc123] [research] step 2 done pages=4`);
    expect(p.scope).toBe("research");
    expect(p.session).toBe("agent:abc123");
  });
});

describe("parseLine — continuations", () => {
  test("stack frames (no ts, no level) are flagged as continuations", () => {
    const p = parseLine(
      "    at <anonymous> (/Users/example/edmund-harness/src/sessions/locks.ts:99:22)",
    );
    expect(p.continuation).toBe(true);
  });

  test("normal lines are not continuations", () => {
    expect(parseLine(`${TS} [log] [cron] fire ok scheduled job=j1`).continuation).toBe(false);
  });
});

describe("normalizeSession", () => {
  test("strips imessage:, truncates group hashes, promotes bare handles", () => {
    expect(normalizeSession("imessage:dm:+15550100001")).toBe("dm:+15550100001");
    // Trailing-6 truncation matches the daemon's shortSession(), so viewer
    // and producer render the same short id for one group.
    expect(normalizeSession("group:any;+;a86f3e9d1b2c4d5e")).toBe("group:2c4d5e…");
    expect(normalizeSession("+15550100003")).toBe("dm:+15550100003");
    expect(normalizeSession("mirror:pi-4")).toBe("mirror:pi-4");
    expect(normalizeSession("?")).toBe("?");
  });
});
