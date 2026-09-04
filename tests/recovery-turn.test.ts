import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPLAYED_KEEP, buildRecoveryEnvelope } from "../src/recovery/turn.ts";
import { StateStore } from "../src/sessions/store.ts";

function inbound(text: string, ts: number, rowId: number) {
  return {
    rowId,
    msgGuid: `guid-${rowId}`,
    chatIdentifier: "+15551234567",
    chatGuid: "chat-1",
    isGroup: false,
    fromHandle: "+15551234567",
    fromMe: false,
    text,
    timestampMs: ts,
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
  };
}

const NOW = 1_700_000_000_000;

describe("buildRecoveryEnvelope", () => {
  test("snapshot: structure is stable so wording changes are intentional", () => {
    const env = buildRecoveryEnvelope({
      errorClass: "request_too_large",
      healed: true,
      rawError: null,
      unanswered: [
        inbound("hey what was that drill model again", NOW - 2 * 3_600_000, 100),
        inbound("the one you said held resale value", NOW - 2 * 3_600_000 + 60_000, 101),
        inbound("?", NOW - 5 * 60_000, 102),
      ],
      nowMs: NOW,
    });
    expect(env).toContain("[Recovery context");
    expect(env).toContain("NEVER mention this to the user");
    expect(env).toContain("Failure class: request_too_large");
    expect(env).toContain("Healed: yes");
    // First message was ~2h ago — should be expressed in hours.
    expect(env).toMatch(/Time since the user's first unanswered message: 2h/);
    expect(env).toContain("hey what was that drill model again");
    expect(env).toContain("the one you said held resale value");
    expect(env).toContain("?");
    expect(env).toContain("Your options:");
    expect(env).toContain("(a) Reply naturally");
    expect(env).toContain("(b) Stay silent");
    expect(env).toContain("(c) If the user pivoted");
    expect(env).toContain("(d) If only nudges arrived");
  });

  test("Healed: no when no healer ran", () => {
    const env = buildRecoveryEnvelope({
      errorClass: "transient_api",
      healed: false,
      rawError: null,
      unanswered: [inbound("hello", NOW - 90_000, 1)],
      nowMs: NOW,
    });
    expect(env).toContain("Healed: no");
  });

  test("includes raw error for unknown class", () => {
    const env = buildRecoveryEnvelope({
      errorClass: "unknown",
      healed: false,
      rawError: "Surprise mystery error",
      unanswered: [inbound("hi", NOW - 90_000, 1)],
      nowMs: NOW,
    });
    expect(env).toContain("Surprise mystery error");
  });

  test("relative-time formatting boundaries", () => {
    const sec = buildRecoveryEnvelope({
      errorClass: "transient_api",
      healed: false,
      rawError: null,
      unanswered: [inbound("hi", NOW - 30_000, 1)],
      nowMs: NOW,
    });
    expect(sec).toMatch(/Time since.*30s/);

    const min = buildRecoveryEnvelope({
      errorClass: "transient_api",
      healed: false,
      rawError: null,
      unanswered: [inbound("hi", NOW - 5 * 60_000, 1)],
      nowMs: NOW,
    });
    expect(min).toMatch(/Time since.*5m/);

    const day = buildRecoveryEnvelope({
      errorClass: "transient_api",
      healed: false,
      rawError: null,
      unanswered: [inbound("hi", NOW - 3 * 86_400_000, 1)],
      nowMs: NOW,
    });
    expect(day).toMatch(/Time since.*3d/);
  });
});

describe("StateStore replayed_inbound + error tracking", () => {
  let dir: string;
  let s: StateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recovery-store-"));
    s = new StateStore(dir);
    s.upsertSession({
      sessionKey: "imessage:dm:+1555",
      claudeSessionId: "abc",
      chatGuid: "chat-1",
      isGroup: 0,
      lastInboundMs: NOW,
      lastOutboundMs: 0,
    });
  });

  afterEach(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("recordError / clearError round-trip", () => {
    s.recordError("imessage:dm:+1555", "request_too_large", NOW);
    let row = s.getSession("imessage:dm:+1555")!;
    expect(row.lastErrorClass).toBe("request_too_large");
    expect(row.lastErrorAtMs).toBe(NOW);
    expect(row.healAttemptsCount).toBe(1);

    s.recordError("imessage:dm:+1555", "request_too_large", NOW + 60_000);
    row = s.getSession("imessage:dm:+1555")!;
    expect(row.healAttemptsCount).toBe(2);

    s.clearError("imessage:dm:+1555");
    row = s.getSession("imessage:dm:+1555")!;
    expect(row.lastErrorClass).toBeNull();
    expect(row.healAttemptsCount).toBe(0);
  });

  test("markReplayed / wasReplayed dedupe correctly", () => {
    expect(s.wasReplayed("imessage:dm:+1555", 100)).toBe(false);
    s.markReplayed("imessage:dm:+1555", 100, NOW);
    expect(s.wasReplayed("imessage:dm:+1555", 100)).toBe(true);
    expect(s.wasReplayed("imessage:dm:+1555", 101)).toBe(false);
  });

  test("pruneReplayed keeps the most recent entries only", () => {
    for (let i = 0; i < REPLAYED_KEEP + 5; i++) {
      s.markReplayed("imessage:dm:+1555", i, NOW + i);
    }
    s.pruneReplayed("imessage:dm:+1555", REPLAYED_KEEP);
    expect(s.wasReplayed("imessage:dm:+1555", 0)).toBe(false);
    expect(s.wasReplayed("imessage:dm:+1555", REPLAYED_KEEP + 4)).toBe(true);
  });

  test("deleteSession removes both session row and replayed entries", () => {
    s.markReplayed("imessage:dm:+1555", 100, NOW);
    s.deleteSession("imessage:dm:+1555");
    expect(s.getSession("imessage:dm:+1555")).toBeNull();
    expect(s.wasReplayed("imessage:dm:+1555", 100)).toBe(false);
  });

  test("re-upserting an existing session doesn't clobber error fields", () => {
    s.recordError("imessage:dm:+1555", "transient_api", NOW);
    s.upsertSession({
      sessionKey: "imessage:dm:+1555",
      claudeSessionId: "abc",
      chatGuid: "chat-1",
      isGroup: 0,
      lastInboundMs: NOW + 30_000,
      lastOutboundMs: 0,
    });
    const row = s.getSession("imessage:dm:+1555")!;
    expect(row.lastErrorClass).toBe("transient_api");
    expect(row.healAttemptsCount).toBe(1);
  });
});
