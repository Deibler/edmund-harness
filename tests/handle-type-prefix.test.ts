import { expect, test } from "bun:test";

import { isOwnHandle } from "../src/gating/reflection.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { normalizeHandle, sessionKeyFor } from "../src/sessions/key.ts";

// IMCore labels an address with its type — "e:" for an email, "p:" for a phone —
// and that form escapes into `account` output and into chat.db as a second
// handle row. While it survived normalization, an address did not compare equal
// to itself, which is how Edmund ended up answering its own messages in its own
// DM: `isOwnHandle` said no, so a self-send was treated as a stranger writing in.

const SELF = ["bot@example.com", "bot-alt@example.com"];

test("the type prefix does not survive normalization", () => {
  expect(normalizeHandle("e:bot@example.com")).toBe("bot@example.com");
  expect(normalizeHandle("E:bot@example.com")).toBe("bot@example.com");
  expect(normalizeHandle("p:+15550100001")).toBe("+15550100001");
  expect(normalizeHandle("P:+15550100001")).toBe("+15550100001");
});

test("our own address is recognised however IMCore spells it", () => {
  for (const spelling of [
    "bot@example.com",
    "e:bot@example.com",
    "E:bot@example.com",
    "  e:Bot@Example.com  ",
  ]) {
    expect(isOwnHandle(spelling, SELF), spelling).toBe(true);
  }
});

test("someone else is still someone else", () => {
  for (const other of [
    "+15550100001",
    "p:+15550100001",
    "douglas@example.com",
    "e:doug@example.com",
  ]) {
    expect(isOwnHandle(other, SELF), other).toBe(false);
  }
});

function dm(fromHandle: string): InboundMessage {
  return {
    rowId: 1,
    msgGuid: "G",
    chatIdentifier: fromHandle,
    chatGuid: `any;-;${fromHandle}`,
    isGroup: false,
    fromHandle,
    fromMe: false,
    text: "hi",
    timestampMs: 0,
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
  };
}

test("both spellings land on one session, not two", () => {
  // A second session key for the same address is what produced the
  // `dm:e:bot@example.com` thread sitting beside the real one.
  expect(sessionKeyFor(dm("e:bot@example.com"))).toBe(sessionKeyFor(dm("bot@example.com")));
  expect(sessionKeyFor(dm("p:+15550100001"))).toBe(sessionKeyFor(dm("+15550100001")));
});

test("ordinary handles are untouched", () => {
  expect(normalizeHandle("+1 (555) 010-0001")).toBe("+15550100001");
  expect(normalizeHandle("Someone@Example.COM")).toBe("someone@example.com");
  // A local part that merely contains a colon-ish letter must not be eaten.
  expect(normalizeHandle("pete@example.com")).toBe("pete@example.com");
  expect(normalizeHandle("ed@example.com")).toBe("ed@example.com");
});
