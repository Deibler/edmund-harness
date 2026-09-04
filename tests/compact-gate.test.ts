/**
 * Deferred-compact gate: the registry that lets pipeline.enqueue() abort an
 * in-flight /compact so a user message never waits minutes behind
 * maintenance (the compact-outside-the-lock change, 2026-07-28).
 */
import { describe, expect, test } from "bun:test";
import {
  abortActiveCompact,
  activeCompactCount,
  clearCompact,
  registerCompact,
} from "../src/channels/compact-gate.ts";
import { SessionPipeline } from "../src/channels/pipeline.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { SessionLocks } from "../src/sessions/locks.ts";

let rowId = 1;
function msg(text: string): InboundMessage {
  return {
    rowId: rowId++,
    msgGuid: `guid-${rowId}`,
    chatIdentifier: "+15550000000",
    chatGuid: "iMessage;-;+15550000000",
    isGroup: false,
    fromHandle: "+15550000000",
    fromMe: false,
    text,
    timestampMs: Date.now(),
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
  };
}

describe("compact-gate", () => {
  test("register → abort aborts the signal exactly once", () => {
    const c = registerCompact("k1");
    expect(c.signal.aborted).toBe(false);
    expect(abortActiveCompact("k1")).toBe(true);
    expect(c.signal.aborted).toBe(true);
    // Nothing registered anymore — second abort is a no-op.
    expect(abortActiveCompact("k1")).toBe(false);
    expect(activeCompactCount()).toBe(0);
  });

  test("abort only touches its own session", () => {
    const a = registerCompact("k-a");
    const b = registerCompact("k-b");
    try {
      expect(abortActiveCompact("k-a")).toBe(true);
      expect(a.signal.aborted).toBe(true);
      expect(b.signal.aborted).toBe(false);
    } finally {
      clearCompact("k-b", b);
    }
  });

  test("a stale clear can't drop a newer registration", () => {
    const stale = registerCompact("k2");
    abortActiveCompact("k2");
    const fresh = registerCompact("k2");
    clearCompact("k2", stale); // finally-block of the aborted run, arriving late
    expect(abortActiveCompact("k2")).toBe(true);
    expect(fresh.signal.aborted).toBe(true);
  });

  test("pipeline.enqueue aborts the session's active compact", async () => {
    const c = registerCompact("iMessage;-;+15550000000-key");
    const p = new SessionPipeline({
      debounceMs: 5_000, // never flushes within this test
      handler: async () => {},
      locks: new SessionLocks(),
    });
    p.enqueue("iMessage;-;+15550000000-key", msg("hey are you there?"));
    expect(c.signal.aborted).toBe(true);
    // And the queued message is visible to the pre-start yield check.
    expect(p.queuedCount("iMessage;-;+15550000000-key")).toBe(1);
    p.cancelQueued("iMessage;-;+15550000000-key");
  });
});
