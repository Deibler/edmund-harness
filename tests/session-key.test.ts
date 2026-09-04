import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "../src/imessage/types.ts";
import {
  chatIdFromKey,
  isGroupSession,
  isSubagentSession,
  normalizeHandle,
  sessionKeyFor,
} from "../src/sessions/key.ts";

function msg(over: Partial<InboundMessage>): InboundMessage {
  return {
    rowId: 1,
    msgGuid: "g",
    chatIdentifier: "+15551234567",
    chatGuid: "iMessage;-;+15551234567",
    isGroup: false,
    fromHandle: "+15551234567",
    fromMe: false,
    text: "hi",
    timestampMs: 0,
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
    ...over,
  };
}

describe("normalizeHandle", () => {
  test("lowercases emails", () => {
    expect(normalizeHandle("Alex@ICLOUD.com")).toBe("alex@icloud.com");
    expect(normalizeHandle("  Bob@Example.COM  ")).toBe("bob@example.com");
  });
  test("strips formatting from phone numbers, keeps leading +", () => {
    expect(normalizeHandle("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeHandle("555-123-4567")).toBe("5551234567");
    expect(normalizeHandle(" +1.555.123.4567 ")).toBe("+15551234567");
  });
});

describe("sessionKeyFor", () => {
  test("groups key by chatGuid", () => {
    const k = sessionKeyFor(msg({ isGroup: true, chatGuid: "iMessage;+;chat42" }));
    expect(k).toBe("imessage:group:iMessage;+;chat42");
    expect(isGroupSession(k)).toBe(true);
    expect(chatIdFromKey(k)).toBe("iMessage;+;chat42");
  });

  test("DMs key by canonical handle", () => {
    const k = sessionKeyFor(msg({ fromHandle: "+1 (555) 123-4567" }));
    expect(k).toBe("imessage:dm:+15551234567");
    expect(isGroupSession(k)).toBe(false);
    expect(chatIdFromKey(k)).toBe("+15551234567");
  });

  test("phone and email handles for the same person collapse via contact resolver", () => {
    const resolver = {
      canon: (h: string) =>
        h.includes("@") || h.includes("999") ? "person-1" : normalizeHandle(h),
    };
    const a = sessionKeyFor(msg({ fromHandle: "alex@icloud.com" }), resolver);
    const b = sessionKeyFor(msg({ fromHandle: "+1 555 999 0000" }), resolver);
    expect(a).toBe(b);
    expect(a).toBe("imessage:dm:person-1");
  });

  test("falls back to chatIdentifier when fromHandle is empty", () => {
    const k = sessionKeyFor(msg({ fromHandle: "", chatIdentifier: "+15550009999" }));
    expect(k).toBe("imessage:dm:+15550009999");
  });
});

describe("chatIdFromKey", () => {
  test("returns the key unchanged when it has no known prefix", () => {
    expect(chatIdFromKey("weird-thing")).toBe("weird-thing");
  });
});

describe("isSubagentSession", () => {
  // The MCP server uses this to withhold spawn/handoff/deep-research tools
  // from spawned workers — the depth cap that stops agent-spawns-agent
  // recursion. The EDMUND_AGENT env-flag path is exercised implicitly in the
  // real subprocess, not here.
  test("agent session keys are subagents; personas and DMs are not", () => {
    expect(isSubagentSession("agent:ag_20260728_abc123")).toBe(true);
    expect(isSubagentSession("imessage:dm:+15551234567")).toBe(false);
    expect(isSubagentSession("imessage:group:chat123")).toBe(false);
    expect(isSubagentSession("trading:dm:+15551234567")).toBe(false);
    expect(isSubagentSession("mirror:main")).toBe(false);
  });
});
