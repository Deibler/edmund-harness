import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config/config.ts";
import { gateInbound, isAssistantMentioned, stripMention } from "../src/gating/allowlist.ts";
import type { InboundMessage } from "../src/imessage/types.ts";

function cfg(
  over: { dm?: string[]; groups?: string[]; names?: string[]; open?: boolean } = {},
): Config {
  return {
    identity: { names: over.names ?? ["edmund", "claude"] },
    allowlist: { dm: over.dm ?? [], groups: over.groups ?? [] },
    // An empty list only means "everyone" when [security] opens it.
    security: { open_dm_allowlist: over.open === true, open_group_allowlist: over.open === true },
    orchestrators: [],
  } as unknown as Config;
}

function msg(over: Partial<InboundMessage>): InboundMessage {
  return {
    rowId: 1,
    msgGuid: "g",
    chatIdentifier: "+15551112222",
    chatGuid: "iMessage;-;+15551112222",
    isGroup: false,
    fromHandle: "+15551112222",
    fromMe: false,
    text: "hey",
    timestampMs: 0,
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
    ...over,
  };
}

describe("gateInbound", () => {
  test("rejects our own outbound", () => {
    expect(gateInbound(msg({ fromMe: true }), cfg())).toEqual({ allow: false, reason: "self" });
  });

  test("DM: empty allowlist admits nobody unless [security].open_dm_allowlist opens it", () => {
    expect(gateInbound(msg({}), cfg({ dm: [] }))).toEqual({
      allow: false,
      reason: "not-allowlisted",
    });
    expect(gateInbound(msg({}), cfg({ dm: [], open: true }))).toEqual({ allow: true });
  });

  test("DM: non-allowlisted sender is rejected, allowlisted is allowed (handle-normalized)", () => {
    const c = cfg({ dm: ["+1 (555) 111-2222"] });
    expect(gateInbound(msg({ fromHandle: "+15551112222" }), c)).toEqual({ allow: true });
    expect(gateInbound(msg({ fromHandle: "+15559998888" }), c)).toEqual({
      allow: false,
      reason: "not-allowlisted",
    });
  });

  test("group: unregistered chat is rejected", () => {
    const m = msg({ isGroup: true, chatGuid: "iMessage;+;chatX", text: "edmund hi" });
    expect(gateInbound(m, cfg({ groups: ["iMessage;+;chatY"] }))).toEqual({
      allow: false,
      reason: "group-not-registered",
    });
  });

  test("group: registered but no mention is rejected", () => {
    const m = msg({ isGroup: true, chatGuid: "iMessage;+;chatX", text: "lol nice" });
    expect(gateInbound(m, cfg({ groups: ["iMessage;+;chatX"] }))).toEqual({
      allow: false,
      reason: "not-mentioned",
    });
  });

  test("group: registered + mentioned is allowed", () => {
    const m = msg({ isGroup: true, chatGuid: "iMessage;+;chatX", text: "hey edmund what's up" });
    expect(gateInbound(m, cfg({ groups: ["iMessage;+;chatX"] }))).toEqual({ allow: true });
  });

  test("group: empty groups list registers none unless opened; opened still needs a mention", () => {
    expect(gateInbound(msg({ isGroup: true, text: "edmund?" }), cfg({ groups: [] }))).toEqual({
      allow: false,
      reason: "group-not-registered",
    });
    const c = cfg({ groups: [], open: true });
    expect(gateInbound(msg({ isGroup: true, text: "edmund?" }), c)).toEqual({ allow: true });
    expect(gateInbound(msg({ isGroup: true, text: "no mention" }), c)).toEqual({
      allow: false,
      reason: "not-mentioned",
    });
  });
});

describe("isAssistantMentioned", () => {
  test("word-boundary and @-mention matches, case-insensitive", () => {
    const names = ["edmund", "claude"];
    expect(isAssistantMentioned("hey Edmund", names)).toBe(true);
    expect(isAssistantMentioned("@claude do the thing", names)).toBe(true);
    expect(isAssistantMentioned("EDMUND, ping", names)).toBe(true);
    expect(isAssistantMentioned("ask claude.", names)).toBe(true);
  });
  test("substring of another word does not match", () => {
    expect(isAssistantMentioned("edmunds car is here", ["edmund"])).toBe(false); // \b after 'edmund' is 's'? actually 'edmunds' -> \bedmund\b fails
  });
  test("no name present", () => {
    expect(isAssistantMentioned("just chatting", ["edmund"])).toBe(false);
  });
});

describe("stripMention", () => {
  test("removes a leading name + separator", () => {
    expect(stripMention("edmund, what's the weather", ["edmund"])).toBe("what's the weather");
    expect(stripMention("hey edmund do X", ["edmund"])).toBe("do X");
    expect(stripMention("@edmund: status?", ["edmund"])).toBe("status?");
  });
  test("leaves a non-leading mention alone", () => {
    expect(stripMention("ask edmund about it", ["edmund"])).toBe("ask edmund about it");
  });
  test("no-op when no mention", () => {
    expect(stripMention("just text", ["edmund"])).toBe("just text");
  });
});
