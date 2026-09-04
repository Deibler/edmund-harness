import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPipeline } from "../src/channels/pipeline.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { createSmsChannel } from "../src/sms/channel.ts";
import { classifyKeyword } from "../src/sms/inbound.ts";

const OWN = "+15550100000";

function makeConfig(smsOver: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: {},
    identity: {},
    sms: { enabled: true, from: OWN, messaging_service_sid: "MGtest", ...smsOver },
  });
}

type Enq = {
  key: string;
  msg: { text: string; isGroup: boolean; fromHandle: string; chatGuid: string; service: string };
};

function makeChannel(smsOver: Record<string, unknown> = {}, known: string[] = ["+15551230001"]) {
  const enqueued: Enq[] = [];
  const pipeline = {
    enqueue: (key: string, msg: Enq["msg"]) => enqueued.push({ key, msg }),
  } as unknown as SessionPipeline;
  const channel = createSmsChannel({
    config: makeConfig(smsOver),
    creds: { accountSid: "ACtest", keySid: "SKtest", keySecret: "secret" },
    pipeline,
    dataDir: mkdtempSync(join(tmpdir(), "sms-test-")),
    ownNumber: OWN,
    isKnownSender: (h) => known.includes(h),
  });
  return { channel, enqueued };
}

// Capture Twilio API calls instead of letting them near the network.
let fetchCalls: { url: string; body: string }[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({ sid: `SM${fetchCalls.length}`, status: "queued", num_segments: "1" }),
      { status: 201 },
    );
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const dmParams = (over: Record<string, string> = {}) => ({
  ConversationSid: "CHdm1",
  MessageSid: over.MessageSid ?? "IMa",
  Author: "+15551230001",
  Body: "hey edmund, what time is the game?",
  ...over,
});

describe("sms inbound DM", () => {
  test("admitted sender is enqueued on an sms:dm: key with an sms: chat guid", async () => {
    const { channel, enqueued } = makeChannel();
    channel.store.registerConversation("CHdm1", "dm", "+15551230001");
    await channel.onMessageAdded(dmParams());
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.key).toBe("sms:dm:+15551230001");
    expect(enqueued[0]!.msg.chatGuid).toBe("sms:+15551230001");
    expect(enqueued[0]!.msg.service).toBe("SMS");
    expect(enqueued[0]!.msg.isGroup).toBe(false);
    // and the transcript recorded it
    const lines = channel.store.recentLines("+15551230001", 5);
    expect(lines.length).toBe(1);
    expect(lines[0]!.fromMe).toBe(false);
  });

  test("a webhook retry (same MessageSid) is processed exactly once", async () => {
    const { channel, enqueued } = makeChannel();
    channel.store.registerConversation("CHdm1", "dm", "+15551230001");
    await channel.onMessageAdded(dmParams());
    await channel.onMessageAdded(dmParams());
    expect(enqueued.length).toBe(1);
  });

  test("our own authored message (group echo) never becomes a turn", async () => {
    // OWN is deliberately in the known-senders list here: the admission gate
    // would otherwise reject our own number and mask a missing echo filter —
    // this test proved decorative once, passing with the filter deleted.
    const { channel, enqueued } = makeChannel({}, ["+15551230001", OWN]);
    channel.store.registerConversation("CHdm1", "dm", "+15551230001");
    await channel.onMessageAdded(dmParams({ Author: OWN, MessageSid: "IMecho" }));
    expect(enqueued.length).toBe(0);
    // and it must not pollute the transcript as an inbound either
    expect(channel.store.recentLines("+15551230001", 5).length).toBe(0);
  });

  test("an unknown sender is ignored by default", async () => {
    const { channel, enqueued } = makeChannel({}, []);
    channel.store.registerConversation("CHdm1", "dm", "+15551230001");
    await channel.onMessageAdded(dmParams());
    expect(enqueued.length).toBe(0);
  });

  test("allow_unknown_senders opens the door deliberately", async () => {
    const { channel, enqueued } = makeChannel({ allow_unknown_senders: true }, []);
    channel.store.registerConversation("CHdm1", "dm", "+15551230001");
    await channel.onMessageAdded(dmParams());
    expect(enqueued.length).toBe(1);
  });

  test("an explicit allowlist beats known-contact status", async () => {
    // known sender NOT on the configured allowlist → refused
    const { channel, enqueued } = makeChannel({ allowlist: ["+15559990000"] });
    channel.store.registerConversation("CHdm1", "dm", "+15551230001");
    await channel.onMessageAdded(dmParams());
    expect(enqueued.length).toBe(0);
  });
});

describe("sms STOP/START in a DM", () => {
  test("STOP records opt-out, never reaches the model, and blocks later sends", async () => {
    const { channel, enqueued } = makeChannel();
    channel.store.registerConversation("CHdm1", "dm", "+15551230001");
    await channel.onMessageAdded(dmParams({ Body: "STOP", MessageSid: "IMstop" }));
    expect(enqueued.length).toBe(0);
    expect(channel.store.isOptedOut("+15551230001")).toBe(true);
    // the deliverer refuses BEFORE any Twilio call
    fetchCalls = [];
    const res = await channel.deliverer({
      chatGuid: "sms:+15551230001",
      isGroup: false,
      text: "hey, one more thing",
    });
    expect(res.sent).toBe(0);
    expect(res.errors[0]).toContain("opted out");
    expect(fetchCalls.length).toBe(0);
  });

  test("START restores consent", async () => {
    const { channel } = makeChannel();
    channel.store.registerConversation("CHdm1", "dm", "+15551230001");
    await channel.onMessageAdded(dmParams({ Body: "STOP", MessageSid: "IMs1" }));
    await channel.onMessageAdded(dmParams({ Body: "START", MessageSid: "IMs2" }));
    expect(channel.store.isOptedOut("+15551230001")).toBe(false);
  });

  test('"stop by the store" is a message, not an opt-out', async () => {
    const { channel, enqueued } = makeChannel();
    channel.store.registerConversation("CHdm1", "dm", "+15551230001");
    await channel.onMessageAdded(
      dmParams({ Body: "stop by the store when you can", MessageSid: "IMs3" }),
    );
    expect(channel.store.isOptedOut("+15551230001")).toBe(false);
    expect(enqueued.length).toBe(1);
  });
});

describe("sms groups", () => {
  const grpParams = (over: Record<string, string> = {}) => ({
    ConversationSid: "CHgrp1",
    MessageSid: over.MessageSid ?? "IMg1",
    Author: "+15557770002",
    Body: "who's bringing dessert sunday?",
    ...over,
  });

  function groupChannel(known: string[] = ["+15551230001"]) {
    const made = makeChannel({}, known);
    made.channel.store.registerConversation("CHgrp1", "group");
    made.channel.store.upsertGroup({
      conversationSid: "CHgrp1",
      friendlyName: "family",
      participants: ["+15551230001", "+15557770002"],
    });
    return made;
  }

  test("a group with an admitted participant is enqueued on the group key", async () => {
    const { channel, enqueued } = groupChannel();
    await channel.onMessageAdded(grpParams());
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.key).toBe("sms:group:CHgrp1");
    expect(enqueued[0]!.msg.isGroup).toBe(true);
    expect(enqueued[0]!.msg.fromHandle).toBe("+15557770002");
  });

  test("a group where nobody is admitted is ignored", async () => {
    const { channel, enqueued } = groupChannel([]);
    await channel.onMessageAdded(grpParams());
    expect(enqueued.length).toBe(0);
  });

  test('a lone "Stop" in a group is conversation, not a carrier opt-out', async () => {
    const { channel, enqueued } = groupChannel();
    await channel.onMessageAdded(grpParams({ Body: "Stop", MessageSid: "IMg2" }));
    expect(channel.store.isOptedOut("+15557770002")).toBe(false);
    expect(enqueued.length).toBe(1);
  });

  test("group replies POST into the Conversation, not the Messages API", async () => {
    const { channel } = groupChannel();
    const res = await channel.deliverer({
      chatGuid: "sms:CHgrp1",
      isGroup: true,
      text: "I can pick something up on the way.",
    });
    expect(res.sent).toBe(1);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toContain(
      "conversations.twilio.com/v1/Conversations/CHgrp1/Messages",
    );
    expect(fetchCalls[0]!.body).toContain("Author=%2B15550100000");
  });
});

describe("sms outbound DM", () => {
  test("sends via the Messages API with the messaging service", async () => {
    const { channel } = makeChannel();
    const res = await channel.deliverer({
      chatGuid: "sms:+15551230001",
      isGroup: false,
      text: "Game's at 6, I checked.",
    });
    expect(res.sent).toBe(1);
    expect(fetchCalls[0]!.url).toContain("api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
    expect(fetchCalls[0]!.body).toContain("MessagingServiceSid=MGtest");
    // transcript recorded as ours
    const lines = channel.store.recentLines("+15551230001", 5);
    expect(lines[0]!.fromMe).toBe(true);
  });

  test("smart punctuation is normalized before it can triple the bill", async () => {
    const { channel } = makeChannel();
    await channel.deliverer({
      chatGuid: "sms:+15551230001",
      isGroup: false,
      text: "it’s fine — really",
    });
    const body = decodeURIComponent(fetchCalls[0]!.body.replace(/\+/g, " "));
    expect(body).toContain("it's fine - really");
    expect(body).not.toContain("’");
  });

  test("a Twilio 21610 records the opt-out for next time", async () => {
    const { channel } = makeChannel();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 21610, message: "opted out" }), {
        status: 400,
      })) as typeof fetch;
    const res = await channel.deliverer({
      chatGuid: "sms:+15551230001",
      isGroup: false,
      text: "hi",
    });
    expect(res.sent).toBe(0);
    expect(channel.store.isOptedOut("+15551230001")).toBe(true);
  });

  test("a long reply is chunked and every part is sent", async () => {
    const { channel } = makeChannel();
    const res = await channel.deliverer({
      chatGuid: "sms:+15551230001",
      isGroup: false,
      text: "word ".repeat(400).trim(),
    });
    expect(res.sent).toBeGreaterThan(1);
    expect(fetchCalls.length).toBe(res.sent);
  });
});

describe("keyword classifier", () => {
  test("bare keywords with trailing punctuation and case", () => {
    expect(classifyKeyword(" stop. ")).toBe("stop");
    expect(classifyKeyword("UNSUBSCRIBE!")).toBe("stop");
    expect(classifyKeyword("Start")).toBe("start");
    expect(classifyKeyword("help?")).toBe("help");
  });
  test("keywords inside sentences never match", () => {
    expect(classifyKeyword("please stop sending these")).toBe(null);
    expect(classifyKeyword("can you help me move saturday")).toBe(null);
  });
});
