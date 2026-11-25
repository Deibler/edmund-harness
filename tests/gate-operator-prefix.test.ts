/**
 * Is anything the operator writes dropped for how it begins?
 *
 * A message from the operator that began with "Claude " (capital C, then a
 * space) was once left for a separate recovery daemon to answer, and the gate
 * refused it here. That daemon was retired; the gate stayed. From then on a
 * text such as "Claude said the build passed, can you check" was dropped at
 * admission, with no log line unless DEBUG was set and no reply ever. Found on
 * 2026-11-25 by asking which code a retired feature had left running: the
 * gate's own log tag had last appeared in June.
 */
import { describe, expect, test } from "bun:test";

import { shouldAccept } from "../src/channels/turn.ts";
import type { Config } from "../src/config/config.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import type { EchoCache } from "../src/sessions/echo-cache.ts";

const OPERATOR = "+15550100001";

const config = {
  self: { handles: ["bot@example.com"] },
  alerts: { operator_handle: OPERATOR },
  allowlist: { dm: [], groups: [] },
  // This file tests one gate, not admission; keep the open list.
  security: { open_dm_allowlist: true, open_group_allowlist: true },
} as unknown as Config;
const echoes = { isEcho: () => false } as unknown as EchoCache;

function fromOperator(text: string): InboundMessage {
  return {
    rowId: 1,
    msgGuid: "G",
    chatIdentifier: OPERATOR,
    chatGuid: `any;-;${OPERATOR}`,
    isGroup: false,
    fromHandle: OPERATOR,
    fromMe: false,
    text,
    timestampMs: Date.now(),
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
  };
}

describe("a message from the operator", () => {
  test("is accepted when it begins with the word Claude", () => {
    expect(
      shouldAccept(fromOperator("Claude said the build passed, can you check"), config, echoes),
    ).toBe(true);
  });

  test("is accepted whatever it begins with", () => {
    for (const text of ["Claude ", "Claude restart the daemon", "claude code is down", "hello"]) {
      expect([text, shouldAccept(fromOperator(text), config, echoes)]).toEqual([text, true]);
    }
  });
});
