/**
 * Does anything our own address said ever open a turn?
 *
 * A message sent to our own account produces an incoming echo row — fromMe=0,
 * sender = our own handle, sometimes in IMCore's "e:"-prefixed spelling. The
 * gate used to check own-handle only on fromMe rows, so a misdelivered send's
 * echo woke a session in Edmund's own DM that spent real turns dissecting its
 * own debris (frame extraction, transcription, a reply to itself).
 */
import { describe, expect, test } from "bun:test";

import { shouldAccept } from "../src/channels/turn.ts";
import type { Config } from "../src/config/config.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import type { EchoCache } from "../src/sessions/echo-cache.ts";

const SELF = "bot@example.com";

const config = {
  self: { handles: [SELF] },
  alerts: {},
  allowlist: { dm: [], groups: [] },
  // This file tests the own-handle gate, not admission; keep the open list.
  security: { open_dm_allowlist: true, open_group_allowlist: true },
} as unknown as Config;
const echoes = { isEcho: () => false } as unknown as EchoCache;

function msg(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    rowId: 1,
    msgGuid: "G",
    chatIdentifier: "+15550100002",
    chatGuid: "any;-;+15550100002",
    isGroup: false,
    fromHandle: "+15550100002",
    fromMe: false,
    text: "hello",
    timestampMs: Date.now(),
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
    ...overrides,
  };
}

describe("the own-handle gate", () => {
  test("an incoming echo from our own e:-spelled address is rejected", () => {
    const echo = msg({
      fromHandle: `e:${SELF}`,
      chatIdentifier: `e:${SELF}`,
      chatGuid: `any;-;e:${SELF}`,
    });
    expect(shouldAccept(echo, config, echoes)).toBe(false);
  });

  test("an incoming echo from our own plain address is rejected", () => {
    const echo = msg({ fromHandle: SELF, chatIdentifier: SELF, chatGuid: `any;-;${SELF}` });
    expect(shouldAccept(echo, config, echoes)).toBe(false);
  });

  test("our own send into the self thread is rejected even with no handle row", () => {
    const selfSend = msg({
      fromMe: true,
      fromHandle: "",
      chatIdentifier: `e:${SELF}`,
      chatGuid: `any;-;e:${SELF}`,
    });
    expect(shouldAccept(selfSend, config, echoes)).toBe(false);
  });

  test("a real message from a real person is accepted", () => {
    expect(shouldAccept(msg({}), config, echoes)).toBe(true);
  });
});
