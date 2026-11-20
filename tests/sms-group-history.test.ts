import { describe, expect, test } from "bun:test";
import type { Deps } from "../src/channels/deps.ts";
import { buildEnvelope } from "../src/channels/envelope.ts";
import { buildHistoryBundle } from "../src/channels/history.ts";
import { ConfigSchema } from "../src/config/config.ts";
import type { ChatDb } from "../src/imessage/db.ts";
import type { HistoryLine } from "../src/imessage/history.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import type { SessionKey } from "../src/sessions/key.ts";

/**
 * A group text used to carry the last `history_messages` (75) lines on every
 * turn, warm or cold. On a weekly-update group that was two months of the
 * same exchange: Edmund's post, "Thanks Edmund", "Anytime, <name>. If you
 * only catch one, make it…". Eight copies of his own recap pattern sat in
 * view of the ninth, and he wrote it again. iMessage groups show only the
 * active thread. These pin the SMS group to that same view, with a chat.db
 * that throws when touched so the SMS branch cannot quietly fall through.
 */

const SID = "CH00000000000000000000000000000077";
const GROUP_KEY = `sms:group:${SID}` as SessionKey;
const PEER = "+15550100031";
const DM_KEY = `sms:dm:${PEER}` as SessionKey;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

const config = ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} });
const contacts = {
  displayName: () => null,
  label: (h: string) => (h === PEER ? "Robin" : null),
  canon: (h: string) => h,
} as unknown as ContactBook;
const chatDb = new Proxy(
  {},
  {
    get() {
      throw new Error("chat.db must not be read for an SMS session");
    },
  },
) as unknown as ChatDb;

let rowId = 0;
function line(atMs: number, text: string, fromMe = false): HistoryLine {
  return {
    rowId: ++rowId,
    timestampMs: atMs,
    fromHandle: fromMe ? "" : PEER,
    fromMe,
    text,
    isTapback: false,
    tapbackTargetIsMe: false,
    tapbackTargetHandle: "",
  };
}

// Six weekly threads, each: Edmund's update, a thanks, his recap reply.
const transcript: HistoryLine[] = [];
for (let week = 6; week >= 1; week--) {
  const t = NOW - week * 7 * DAY;
  transcript.push(line(t, `Weekly update ${week}: the pass is Friday at 6:07am.`, true));
  transcript.push(line(t + 3 * 60_000, "Thanks Edmund"));
  transcript.push(
    line(t + 3 * 60_000 + 5_000, `Anytime, Robin. Recap ${week}: Friday 6:07am.`, true),
  );
}
// This week's update, three minutes before the inbound below.
transcript.push(line(NOW - 3 * 60_000, "Weekly update 0: Venus and the Moon, Saturday 6am.", true));

const INBOUND_MS = NOW;
const inboundText = "Thanks Edmund for the info";
// The webhook records the inbound before enqueueing it, stamped with the
// inbound's own timestamp, so the store already holds it at turn time.
const stored = [...transcript, line(INBOUND_MS, inboundText)];

function smsDeps(): Deps {
  return {
    config,
    chatDb,
    contacts,
    sms: {
      history: (_conversationId: string, limit: number) => stored.slice(-limit),
      groupInfo: () => ({ friendlyName: null, participants: [PEER, "+15550100032"] }),
    },
  } as unknown as Deps;
}

function inbound(isGroup: boolean): InboundMessage {
  return {
    rowId: INBOUND_MS * 1_000,
    msgGuid: "sms-IMtest",
    chatIdentifier: isGroup ? SID : PEER,
    chatGuid: `sms:${isGroup ? SID : PEER}`,
    isGroup,
    fromHandle: PEER,
    fromMe: false,
    text: inboundText,
    timestampMs: INBOUND_MS,
    attachments: [],
    attachmentTranscripts: {},
    service: "SMS",
    replyToGuid: null,
  } as InboundMessage;
}

function bundle(key: SessionKey, isGroup: boolean, coldStart: boolean) {
  const msg = inbound(isGroup);
  return buildHistoryBundle(msg, [msg], coldStart, isGroup, NOW - 3 * 60_000, smsDeps(), key);
}

describe("an SMS group turn shows the active thread, as an iMessage group does", () => {
  test("a warm turn carries this week's thread, not weeks of the same exchange", () => {
    const b = bundle(GROUP_KEY, true, false);
    const text = b.lines.join("\n");
    expect(text).toContain("Weekly update 0");
    expect(text).not.toContain("Anytime, Robin");
    expect(text).not.toContain("Weekly update 1:");
    expect(b.lines.length).toBe(1);
  });

  test("the message being answered is not also shown as history", () => {
    const b = bundle(GROUP_KEY, true, false);
    expect(b.lines.join("\n")).not.toContain(inboundText);
  });

  test("it gets the group scope line and an invocation class", () => {
    const b = bundle(GROUP_KEY, true, false);
    expect(b.scope).toBeDefined();
    expect(b.scope).not.toMatch(/recent messages in this group text/);
    expect(b.invocation).toBeDefined();
  });

  test("a cold start is told earlier threads exist and how to read them", () => {
    const cold = bundle(GROUP_KEY, true, true).lines.join("\n");
    expect(cold).toContain("get_thread_context");
    expect(cold).not.toContain("Anytime, Robin");
    const warm = bundle(GROUP_KEY, true, false).lines.join("\n");
    expect(warm).not.toContain("Earlier conversations in this chat");
  });
});

describe("an SMS DM", () => {
  test("a warm turn carries no history block", () => {
    expect(bundle(DM_KEY, false, false).lines).toEqual([]);
  });

  test("a cold start shows the transcript, without the message being answered", () => {
    const text = bundle(DM_KEY, false, true).lines.join("\n");
    expect(text).toContain("Weekly update 0");
    expect(text).not.toContain(inboundText);
  });
});

describe("the SMS envelope", () => {
  const env = (service: "SMS" | "iMessage") =>
    buildEnvelope({
      messages: [{ ...inbound(true), service }],
      senderLabel: "Robin",
      lastInboundMs: null,
      isGroup: true,
      contacts,
      historyLines: ["  [You · Mon 18:01] Weekly update 0"],
    });

  test("does not offer reactions or reply-threading it cannot do", () => {
    expect(env("SMS")).not.toContain("you can react to");
    expect(env("iMessage")).toContain("you can react to");
  });

  test("tells a group that every text is billed per person, so progress pings get folded in", () => {
    expect(env("SMS")).toContain("per person in the room (they pay nothing)");
    expect(env("iMessage")).not.toContain("per person in the room");
  });

  test("says photos and files work both ways, so it stops sending people to iMessage", () => {
    expect(env("SMS")).toContain("send_attachment sends yours as MMS");
    expect(env("iMessage")).not.toContain("as MMS");
  });

  test("names KEEP_QUIET as the answer a tapback would have been, and forbids the recap", () => {
    const e = env("SMS");
    expect(e).toContain("KEEP_QUIET");
    expect(e).toMatch(/Never restate what you already sent/);
    expect(env("iMessage")).not.toMatch(/Never restate what you already sent/);
  });
});
