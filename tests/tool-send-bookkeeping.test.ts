/**
 * Mid-turn tool sends (send_message / send_attachment) must be visible to the
 * recovery bookkeeping at SEND time, not just at end-of-turn. These tests
 * cover the two layers:
 *
 *  - StateStore.noteToolSend — the narrow last_outbound_ms bump, including
 *    the sweeper-eligibility effect (the mechanism that used to re-fire
 *    recovery turns on bursts the user had already seen answered).
 *  - recordToolSend (mcp/tools/message.ts) — the post-send hook, which opens
 *    its own state.db handle from the MCP subprocess and also records a
 *    sent-attribution row like the deliverReply path does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordToolSend } from "../src/mcp/tools/message.ts";
import { StateStore } from "../src/sessions/store.ts";

const KEY = "imessage:dm:+1555";
const CHAT = "chat-guid-1";
const NOW = 1_750_000_000_000;

let dir: string;
let s: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-toolsend-"));
  s = new StateStore(dir);
  s.upsertSession({
    sessionKey: KEY,
    claudeSessionId: "abc",
    chatGuid: CHAT,
    isGroup: 0,
    lastInboundMs: NOW,
    lastOutboundMs: 0,
  });
});

afterEach(() => {
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("StateStore.noteToolSend", () => {
  test("bumps last_outbound_ms on an existing row, leaving everything else alone", () => {
    expect(s.noteToolSend(KEY, NOW + 5_000)).toBe(true);
    const row = s.getSession(KEY)!;
    expect(row.lastOutboundMs).toBe(NOW + 5_000);
    expect(row.lastInboundMs).toBe(NOW);
    expect(row.claudeSessionId).toBe("abc");
  });

  test("is monotonic — a stale timestamp never moves the clock backwards", () => {
    s.noteToolSend(KEY, NOW + 10_000);
    s.noteToolSend(KEY, NOW + 2_000);
    expect(s.getSession(KEY)!.lastOutboundMs).toBe(NOW + 10_000);
  });

  test("no-ops (returns false) for a session with no row", () => {
    expect(s.noteToolSend("imessage:dm:+1666", NOW)).toBe(false);
    expect(s.getSession("imessage:dm:+1666")).toBeNull();
  });

  test("a tool send makes the session ineligible for the recovery sweep", () => {
    // Before: the session owes a reply → sweeper candidate.
    expect(s.listSessionsNeedingRecovery(NOW + 600_000).map((r) => r.sessionKey)).toContain(KEY);
    // The model sends the reply via send_message mid-turn, then the turn dies
    // before end-of-turn bookkeeping. The send-time bump alone must be enough
    // to keep the sweeper from re-firing on the answered burst.
    s.noteToolSend(KEY, NOW + 5_000);
    expect(s.listSessionsNeedingRecovery(NOW + 600_000)).toHaveLength(0);
  });
});

describe("recordToolSend", () => {
  const deps = () => ({ dataDir: dir, sessionKey: KEY, chatGuids: [CHAT] });

  test("bumps last_outbound_ms and records an attribution row for the sent text", () => {
    recordToolSend(deps(), "on it, gimme a sec");
    const row = s.getSession(KEY)!;
    expect(row.lastOutboundMs).toBeGreaterThan(0);
    const attrs = s.attributionsFor(CHAT, 0);
    expect(attrs).toHaveLength(1);
    expect(attrs[0]!.text).toBe("on it, gimme a sec");
    expect(attrs[0]!.orchestrator).toBe("main");
  });

  test("an explicit chatGuid (reply_to resolution) wins over the session default", () => {
    recordToolSend(deps(), "answering the older thread", "chat-guid-2");
    expect(s.attributionsFor("chat-guid-2", 0)).toHaveLength(1);
    expect(s.attributionsFor(CHAT, 0)).toHaveLength(0);
  });

  test("captionless attachment still bumps the outbound clock, without an attribution row", () => {
    recordToolSend(deps(), "");
    expect(s.getSession(KEY)!.lastOutboundMs).toBeGreaterThan(0);
    expect(s.attributionsFor(CHAT, 0)).toHaveLength(0);
  });

  test("swallows bookkeeping failures — the send already happened", () => {
    // An unwritable data dir makes the StateStore constructor throw inside
    // recordToolSend; the helper must not let that escape to the tool result.
    expect(() =>
      recordToolSend({ dataDir: "/dev/null/nope", sessionKey: KEY, chatGuids: [CHAT] }, "hi"),
    ).not.toThrow();
  });
});
