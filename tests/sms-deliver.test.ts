import { afterEach, describe, expect, test } from "bun:test";
import { deliverReply, setSmsDeliverer } from "../src/channels/deliver.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { EchoCache } from "../src/sessions/echo-cache.ts";

// A config whose chat_db path does not exist: if the SMS branch ever falls
// through into the chat.db resolution path, ChatDb throws and the test sees
// the error string instead of a clean delivery.
const config = ConfigSchema.parse({
  self: { handles: [] },
  allowlist: {},
  identity: {},
  paths: { chat_db: "/nonexistent/never/chat.db" },
});

afterEach(() => setSmsDeliverer(null));

describe("deliverReply sms routing", () => {
  test("an sms: chatGuid routes to the registered sms deliverer", async () => {
    const calls: { chatGuid: string; isGroup: boolean; text: string }[] = [];
    setSmsDeliverer(async (args) => {
      calls.push(args);
      return { sent: 1, sentChunks: [args.text], errors: [], silenced: false };
    });
    const echoes = new EchoCache();
    const res = await deliverReply(
      { to: "+15551230001", isGroup: false, text: "hello", chatGuid: "sms:+15551230001" },
      config,
      echoes,
    );
    expect(res.sent).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]!.chatGuid).toBe("sms:+15551230001");
    // sent chunks are echo-recorded so a looped webhook can't re-trigger us
    expect(echoes.isEcho("hello")).toBe(true);
  });

  test("a group delivery routes by the sms: guid in `to`", async () => {
    const calls: { chatGuid: string; isGroup: boolean }[] = [];
    setSmsDeliverer(async (args) => {
      calls.push(args);
      return { sent: 1, sentChunks: [args.text], errors: [], silenced: false };
    });
    const res = await deliverReply(
      { to: "sms:CHgrp1", isGroup: true, text: "on my way" },
      config,
      new EchoCache(),
    );
    expect(res.sent).toBe(1);
    expect(calls[0]!.chatGuid).toBe("sms:CHgrp1");
    expect(calls[0]!.isGroup).toBe(true);
  });

  test("an sms delivery with no deliverer registered fails loudly, not silently", async () => {
    const res = await deliverReply(
      { to: "+15551230001", isGroup: false, text: "hello", chatGuid: "sms:+15551230001" },
      config,
      new EchoCache(),
    );
    expect(res.sent).toBe(0);
    expect(res.errors[0]).toContain("sms deliverer not registered");
  });

  test("sanitize/flatten still runs before the sms branch", async () => {
    let got = "";
    setSmsDeliverer(async (args) => {
      got = args.text;
      return { sent: 1, sentChunks: [args.text], errors: [], silenced: false };
    });
    await deliverReply(
      {
        to: "+15551230001",
        isGroup: false,
        text: "**bold** and _italic_",
        chatGuid: "sms:+15551230001",
      },
      config,
      new EchoCache(),
    );
    expect(got).not.toContain("**");
  });
});
