import { describe, expect, test } from "bun:test";
import { buildEnvelope } from "../src/channels/envelope.ts";
import type { InboundMessage } from "../src/imessage/types.ts";

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    rowId: 1,
    msgGuid: "guid-1",
    chatIdentifier: "+15551234567",
    chatGuid: "chat-1",
    isGroup: false,
    fromHandle: "+15551234567",
    fromMe: false,
    text: "about this?",
    timestampMs: 1_700_000_000_000,
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
    ...overrides,
  };
}

describe("buildEnvelope pendingAttachments", () => {
  test("says the attachment is not coming, without promising a follow-up turn", () => {
    const out = buildEnvelope({
      messages: [inbound()],
      senderLabel: "Sam Rivera",
      lastInboundMs: null,
      isGroup: false,
      pendingAttachments: 2,
    });
    expect(out).toContain("Pending attachments: 2");
    expect(out).toContain("no later turn will bring them in");
    expect(out).toContain("ask them to send them again");
    // It used to promise a follow-up turn "within seconds" and tell the model
    // to stay quiet until then. Nothing re-runs the turn: on 2026-10-20 the
    // person's next turn was their own new message five hours later.
    expect(out).not.toMatch(/follow-up turn|stay quiet until/);
  });

  test("omits the line entirely when pending count is 0 or missing", () => {
    const noArg = buildEnvelope({
      messages: [inbound()],
      senderLabel: "Sam Rivera",
      lastInboundMs: null,
      isGroup: false,
    });
    expect(noArg).not.toContain("Pending attachments");

    const zero = buildEnvelope({
      messages: [inbound()],
      senderLabel: "Sam Rivera",
      lastInboundMs: null,
      isGroup: false,
      pendingAttachments: 0,
    });
    expect(zero).not.toContain("Pending attachments");
  });

  test("dead temp paths are NOT in the envelope when caller stripped them", () => {
    // The caller (main.ts) is responsible for stripping pending paths
    // from msg.attachments before calling buildEnvelope. Verify that
    // when caller does that, the envelope shows no Attachments line.
    const out = buildEnvelope({
      messages: [inbound({ attachments: [] })],
      senderLabel: "Sam Rivera",
      lastInboundMs: null,
      isGroup: false,
      pendingAttachments: 1,
    });
    expect(out).not.toContain("/var/folders/");
    expect(out).not.toContain("Attachments:"); // since attachments[] is empty
    expect(out).toContain("Pending attachments: 1"); // but the marker is there
  });
});
