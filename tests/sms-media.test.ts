import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPipeline } from "../src/channels/pipeline.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { createSmsChannel } from "../src/sms/channel.ts";

/**
 * Photos over SMS were dropped, every one: 9 arrived on the live account
 * between 2026-09-01 and 2026-11-03 and the harness recorded none. Twilio
 * delivers each photo as its OWN Conversations message with an empty body
 * (a text-plus-photo MMS arrives as two messages in the same second), and
 * the handler read `NumMedia`, a Programmable Messaging parameter the
 * Conversations webhook never sends, then returned on the empty body.
 *
 * The shapes below are the measured ones:
 *  - webhook params: the onMessageAdded set from Twilio's docs, with the
 *    empty body the live photo messages carried. The `Media` param's key
 *    casing is NOT documented and was never captured, so the handler must
 *    not depend on it; one case omits it entirely.
 *  - REST `media`: copied from the live record of a photo message.
 *  - MCS: `GET mcs.us1.twilio.com/v1/Services/{IS}/Media/{ME}` with auth
 *    returns `links.content_direct_temporary`, a signed media.us1 URL that
 *    serves the bytes without auth for 300 seconds.
 */

const OWN = "+15550100000";
const AUTHOR = "+15551230001";
const OTHER = "+15557770002";
const GROUP = "CH00000000000000000000000000000aa1";
const DM_CONV = "CH00000000000000000000000000000aa2";
const SERVICE = "IS00000000000000000000000000000aa3";
const MEDIA_SID = "ME00000000000000000000000000000aa4";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// The live REST record's `media` array, verbatim but for the sid.
const restMedia = [
  {
    category: "media",
    content_type: "image/png",
    filename: "PNG image.png",
    sid: MEDIA_SID,
    size: PNG.length,
  },
];

function webhook(over: Record<string, string> = {}): Record<string, string> {
  return {
    AccountSid: "AC00000000000000000000000000000aa5",
    EventType: "onMessageAdded",
    Source: "SMS",
    ConversationSid: GROUP,
    MessageSid: "IM00000000000000000000000000000aa6",
    ChatServiceSid: SERVICE,
    MessagingServiceSid: "MG00000000000000000000000000000aa7",
    ParticipantSid: "MB00000000000000000000000000000aa8",
    Index: "41",
    DateCreated: "2026-11-03T19:30:25.000Z",
    Author: AUTHOR,
    Body: "",
    Attributes: "{}",
    RetryCount: "0",
    // Casing unverified; present only to look like the real request.
    Media: JSON.stringify([
      { Sid: MEDIA_SID, ContentType: "image/png", Filename: "PNG image.png", Size: PNG.length },
    ]),
    ...over,
  };
}

type Enq = {
  key: string;
  msg: { text: string; attachments: string[]; timestampMs: number; isGroup: boolean };
};

let dirs: string[] = [];
let mcsStatus = 200;
let fetchCalls: { url: string; auth: string | null }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  mcsStatus = 200;
  fetchCalls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    fetchCalls.push({ url, auth: headers.get("authorization") });
    if (url.startsWith(`https://mcs.us1.twilio.com/v1/Services/${SERVICE}/Media/${MEDIA_SID}`)) {
      if (mcsStatus !== 200) return new Response("{}", { status: mcsStatus });
      return Response.json({
        sid: MEDIA_SID,
        service_sid: SERVICE,
        content_type: "image/png",
        filename: "PNG image.png",
        size: PNG.length,
        links: {
          content: `/v1/Services/${SERVICE}/Media/${MEDIA_SID}/Content`,
          content_direct_temporary: `https://media.us1.twilio.com/${MEDIA_SID}?Expires=1&Signature=s&Key-Pair-Id=k`,
        },
      });
    }
    if (url.startsWith(`https://media.us1.twilio.com/${MEDIA_SID}`)) {
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeChannel(media: unknown[] | null = restMedia) {
  const dataDir = mkdtempSync(join(tmpdir(), "sms-media-"));
  dirs.push(dataDir);
  const enqueued: Enq[] = [];
  const lookups: string[] = [];
  const channel = createSmsChannel({
    config: ConfigSchema.parse({
      self: { handles: [] },
      allowlist: {},
      identity: {},
      sms: { enabled: true, from: OWN, messaging_service_sid: "MGtest" },
    }),
    creds: { accountSid: "ACtest", keySid: "SKtest", keySecret: "secret" },
    pipeline: {
      enqueue: (key: string, msg: Enq["msg"]) => enqueued.push({ key, msg }),
    } as unknown as SessionPipeline,
    dataDir,
    ownNumber: OWN,
    isKnownSender: (h) => h === AUTHOR,
    // The REST message record, as the SDK hands it back.
    fetchMessageMedia: async (conversationSid: string, messageSid: string) => {
      lookups.push(`${conversationSid}/${messageSid}`);
      return media;
    },
  });
  channel.store.registerConversation(GROUP, "group");
  channel.store.upsertGroup({
    conversationSid: GROUP,
    friendlyName: null,
    participants: [AUTHOR, OTHER],
  });
  channel.store.registerConversation(DM_CONV, "dm", AUTHOR);
  return { channel, enqueued, lookups };
}

describe("a photo sent over SMS", () => {
  test("reaches the model as an attachment with the exact bytes", async () => {
    const { channel, enqueued } = makeChannel();
    await channel.onMessageAdded(webhook());
    expect(enqueued.length).toBe(1);
    const att = enqueued[0]!.msg.attachments;
    expect(att.length).toBe(1);
    expect(att[0]!.endsWith(".png")).toBe(true);
    expect(existsSync(att[0]!)).toBe(true);
    expect(new Uint8Array(readFileSync(att[0]!))).toEqual(PNG);
  });

  test("is found from the REST record, not the undocumented webhook Media field", async () => {
    const { channel, enqueued, lookups } = makeChannel();
    const { Media: _unused, ...params } = webhook();
    await channel.onMessageAdded(params);
    expect(lookups).toEqual([`${GROUP}/IM00000000000000000000000000000aa6`]);
    expect(enqueued[0]?.msg.attachments.length).toBe(1);
  });

  test("downloads through MCS with auth, then the signed link without it", async () => {
    const { channel } = makeChannel();
    await channel.onMessageAdded(webhook());
    const mcs = fetchCalls.find((c) => c.url.includes("mcs.us1.twilio.com"));
    const signed = fetchCalls.find((c) => c.url.includes("media.us1.twilio.com"));
    expect(mcs?.auth).toBe(`Basic ${Buffer.from("SKtest:secret").toString("base64")}`);
    expect(signed).toBeDefined();
    expect(signed?.auth).toBeNull();
  });

  test("arrives in a DM too", async () => {
    const { channel, enqueued } = makeChannel();
    await channel.onMessageAdded(webhook({ ConversationSid: DM_CONV }));
    expect(enqueued[0]?.key).toBe(`sms:dm:${AUTHOR}`);
    expect(enqueued[0]?.msg.attachments.length).toBe(1);
  });

  test("leaves a mark in the transcript so later turns know it was sent", async () => {
    const { channel } = makeChannel();
    await channel.onMessageAdded(webhook());
    const lines = channel.store.recentLines(GROUP, 5);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toContain("photo");
  });

  test("that fails to download is named to the model, never silently dropped", async () => {
    mcsStatus = 404;
    const { channel, enqueued } = makeChannel();
    await channel.onMessageAdded(webhook());
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.msg.attachments).toEqual([]);
    expect(enqueued[0]!.msg.text).toMatch(/didn't come through/);
  });
});

describe("an empty SMS message", () => {
  test("with no media on the record is still dropped", async () => {
    const { channel, enqueued } = makeChannel([]);
    const { Media: _unused, ...params } = webhook();
    await channel.onMessageAdded(params);
    expect(enqueued.length).toBe(0);
  });
});

describe("the transcript row and the turn", () => {
  test("carry one timestamp, which history uses to leave the message out", async () => {
    const { channel, enqueued } = makeChannel();
    await channel.onMessageAdded(webhook({ Body: "Edmund, here's the sheet" }));
    const row = channel.store.recentLines(GROUP, 5).at(-1)!;
    expect(row.timestampMs).toBe(enqueued[0]!.msg.timestampMs);
  });
});

describe("a plain text", () => {
  test("costs no media lookup, even if the webhook sends an empty Media list", async () => {
    const { channel, enqueued, lookups } = makeChannel();
    await channel.onMessageAdded(webhook({ Body: "Edmund, what time is it?", Media: "[]" }));
    expect(lookups).toEqual([]);
    expect(enqueued[0]?.msg.attachments).toEqual([]);
  });
});
