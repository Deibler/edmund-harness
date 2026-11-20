import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import type { ConversationMediaApi } from "../src/sms/media.ts";
import { createSmsSender } from "../src/sms/sender.ts";

/**
 * Sending a file into an SMS conversation, as MMS. The flow is Twilio's
 * documented REST path for Conversations media (conversations/media-support):
 * POST the bytes to the conversation's Media Content Service, then post a
 * message carrying the returned MediaSid within five minutes. The upload
 * response below is the shape the live service returned on 2026-11-03.
 *
 * The Conversations calls go through the official SDK, which does not use
 * fetch, so they are injected here; the MCS upload is plain HTTP and is
 * intercepted at fetch, as Twilio would see it.
 */

const OWN = "+15550100000";
const PEER = "+15551230001";
const GROUP = "CH00000000000000000000000000000bb1";
const DM_CONV = "CH00000000000000000000000000000bb2";
const SERVICE = "IS00000000000000000000000000000bb3";
const UPLOADED = "ME00000000000000000000000000000bb4";
// A real 1x1 PNG, so sips can convert it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;
let uploads: { url: string; contentType: string | null; auth: string | null; bytes: number }[];
let texts: { url: string; body: string }[];
let uploadStatus: number;
let posts: Parameters<ConversationMediaApi["postMedia"]>[0][];
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sms-media-send-"));
  uploads = [];
  texts = [];
  posts = [];
  uploadStatus = 201;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.startsWith("https://mcs.us1.twilio.com/")) {
      const body = init?.body as Uint8Array | undefined;
      uploads.push({
        url,
        contentType: headers.get("content-type"),
        auth: headers.get("authorization"),
        bytes: body?.byteLength ?? 0,
      });
      if (uploadStatus !== 201) return new Response("{}", { status: uploadStatus });
      return Response.json(
        {
          sid: UPLOADED,
          service_sid: SERVICE,
          size: body?.byteLength ?? 0,
          content_type: headers.get("content-type"),
          filename: null,
          author: "system",
          category: "media",
          message_sid: null,
          links: { content: `/v1/Services/${SERVICE}/Media/${UPLOADED}/Content` },
        },
        { status: 201 },
      );
    }
    texts.push({ url, body: String(init?.body ?? "") });
    return Response.json({ sid: "IMtext", status: "queued" }, { status: 201 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

function sender() {
  const s = createSmsSender({
    config: ConfigSchema.parse({
      self: { handles: [] },
      allowlist: {},
      identity: {},
      sms: { enabled: true, from: OWN, messaging_service_sid: "MGtest" },
    }),
    creds: { accountSid: "ACtest", keySid: "SKtest", keySecret: "secret" },
    ownNumber: OWN,
    dataDir: dir,
    mediaApi: {
      chatServiceSid: async () => SERVICE,
      postMedia: async (args) => {
        posts.push(args);
        return "IMposted";
      },
    },
  });
  s.store.registerConversation(GROUP, "group");
  s.store.upsertGroup({
    conversationSid: GROUP,
    friendlyName: null,
    participants: [PEER, "+15557770002"],
  });
  s.store.registerConversation(DM_CONV, "dm", PEER);
  return s;
}

function file(name: string, bytes: Uint8Array | string = PNG): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

describe("a file sent into an SMS group", () => {
  test("is uploaded to the conversation's media store, then posted with its MediaSid", async () => {
    const s = sender();
    const res = await s.deliverMedia({
      chatGuid: `sms:${GROUP}`,
      path: file("card.png"),
      caption: "Here's the card",
    });
    expect(res.ok).toBe(true);
    expect(uploads.length).toBe(1);
    expect(uploads[0]!.url).toBe(`https://mcs.us1.twilio.com/v1/Services/${SERVICE}/Media`);
    expect(uploads[0]!.contentType).toBe("image/png");
    expect(uploads[0]!.auth).toBe(`Basic ${Buffer.from("SKtest:secret").toString("base64")}`);
    expect(uploads[0]!.bytes).toBe(PNG.length);
    expect(posts).toEqual([
      { conversationSid: GROUP, author: OWN, mediaSid: UPLOADED, body: "Here's the card" },
    ]);
  });

  test("leaves a [photo] line in the transcript, so history shows it went", async () => {
    const s = sender();
    await s.deliverMedia({ chatGuid: `sms:${GROUP}`, path: file("card.png"), caption: "the card" });
    const last = s.store.recentLines(GROUP, 3).at(-1)!;
    expect(last.fromMe).toBe(true);
    expect(last.text).toBe("[photo] the card");
  });

  test("a failed upload posts nothing and says why", async () => {
    uploadStatus = 500;
    const res = await sender().deliverMedia({ chatGuid: `sms:${GROUP}`, path: file("card.png") });
    expect(res.ok).toBe(false);
    expect(posts.length).toBe(0);
  });

  test("a caption past Twilio's 1,600-character limit goes as its own text first", async () => {
    const res = await sender().deliverMedia({
      chatGuid: `sms:${GROUP}`,
      path: file("card.png"),
      caption: "word ".repeat(400),
    });
    expect(res.ok).toBe(true);
    expect(texts.length).toBeGreaterThan(0);
    expect(posts[0]!.body).toBeUndefined();
  });
});

describe("a file sent into an SMS DM", () => {
  test("goes through the person's own conversation", async () => {
    const res = await sender().deliverMedia({ chatGuid: `sms:${PEER}`, path: file("card.png") });
    expect(res.ok).toBe(true);
    expect(posts[0]!.conversationSid).toBe(DM_CONV);
  });

  test("is refused, before any upload, to someone who opted out", async () => {
    const s = sender();
    s.store.setOptedOut(PEER, "STOP");
    const res = await s.deliverMedia({ chatGuid: `sms:${PEER}`, path: file("card.png") });
    expect(res.ok).toBe(false);
    expect(uploads.length).toBe(0);
  });

  test("is refused, in words, when the person has never texted the number", async () => {
    const res = await sender().deliverMedia({
      chatGuid: "sms:+15559990000",
      path: file("card.png"),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no Twilio conversation");
    expect(uploads.length).toBe(0);
  });
});

describe("what MMS can carry", () => {
  test("a document is refused with what to do instead, and nothing is uploaded", async () => {
    const res = await sender().deliverMedia({
      chatGuid: `sms:${GROUP}`,
      path: file("plan.docx", "x"),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/shelve/);
    expect(uploads.length).toBe(0);
  });

  test("a PDF goes as it is", async () => {
    const res = await sender().deliverMedia({
      chatGuid: `sms:${GROUP}`,
      path: file("menu.pdf", "%PDF-1.4"),
    });
    expect(res.ok).toBe(true);
    expect(uploads[0]!.contentType).toBe("application/pdf");
  });

  const hasSips = spawnSync("which", ["sips"]).status === 0;
  test.if(hasSips)("a HEIC photo is converted to JPEG before it leaves", async () => {
    const png = file("src.png");
    const heic = join(dir, "photo.heic");
    spawnSync("sips", ["-s", "format", "heic", png, "--out", heic]);
    const res = await sender().deliverMedia({ chatGuid: `sms:${GROUP}`, path: heic });
    expect(res.ok).toBe(true);
    expect(uploads[0]!.contentType).toBe("image/jpeg");
    if (res.ok) {
      expect(res.converted).toBe(true);
      expect(readFileSync(res.sentPath).subarray(0, 2).toString("hex")).toBe("ffd8");
    }
  });
});
