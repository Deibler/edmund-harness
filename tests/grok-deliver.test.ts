import { afterEach, describe, expect, mock, test } from "bun:test";

const invoke = mock(() => Promise.resolve({ guid: "G1" }));
mock.module("../src/imessage/bridge/index.ts", () => ({ invoke }));

import { deliverReply, setGrokDeliverer } from "../src/channels/deliver.ts";
import type { Config } from "../src/config/config.ts";
import type { EchoCache } from "../src/sessions/echo-cache.ts";

const HANDLE = "+15550100001";
const DM_GUID = `any;-;${HANDLE}`;
const config = {
  behavior: { chunk_chars: 3000, reply_threading: false },
  // Nothing at this path: the DM guid cannot be resolved, so the send goes by handle.
  paths: { chat_db: "/nonexistent/chat.db" },
  contacts: [],
} as unknown as Config;
const sent: string[] = [];
const echoes = {
  recordSent(t: string) {
    sent.push(t);
  },
} as unknown as EchoCache;

/** A turn in the person's DM session: the real chat guid, as for any text. */
const dmTurn = { to: HANDLE, isGroup: false, chatGuid: DM_GUID };
const requests = ["grok-1"];

afterEach(() => {
  setGrokDeliverer(null);
  invoke.mockClear();
  sent.length = 0;
});

describe("deliverReply on a turn that holds a Grok request", () => {
  test("a reply someone is waiting for is handed over and not texted", async () => {
    const heard: Array<[string, readonly string[]]> = [];
    setGrokDeliverer((t, guids) => {
      heard.push([t, guids]);
      return { spoken: true, textToo: false };
    });
    const res = await deliverReply(
      { ...dmTurn, text: "Four.", grok: { msgGuids: requests, alsoText: false } },
      config,
      echoes,
    );
    expect(res.sent).toBe(1);
    // Spoken, not on the wire: the bookkeeping that reads chat.db skips it.
    expect(res.medium).toBe("voice");
    expect(heard).toEqual([["Four.", requests]]);
    expect(invoke).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  test("a reply nobody is waiting for is texted to the DM, under its real chat guid", async () => {
    setGrokDeliverer(() => ({ spoken: false, textToo: true }));
    const res = await deliverReply(
      { ...dmTurn, text: "Found three options.", grok: { msgGuids: requests, alsoText: false } },
      config,
      echoes,
    );
    expect(res.sent).toBe(1);
    expect(res.medium).toBeUndefined();
    const [, options] = invoke.mock.calls[0] as unknown as [string, { chat: string; text: string }];
    expect(options.text).toBe("Found three options.");
    expect(options.chat).toBe(DM_GUID);
    expect(options.chat.startsWith("grok:")).toBe(false);
  });

  test("a mixed batch (a real text beside the request) is spoken AND texted", async () => {
    const heard: string[] = [];
    setGrokDeliverer((t) => {
      heard.push(t);
      return { spoken: true, textToo: false };
    });
    const res = await deliverReply(
      { ...dmTurn, text: "On it.", grok: { msgGuids: requests, alsoText: true } },
      config,
      echoes,
    );
    expect(heard).toEqual(["On it."]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(1);
    expect(res.medium).toBeUndefined();
    expect(sent).toEqual(["On it."]);
  });

  test("a request that already gave up and one still waiting: the reply is spoken and texted", async () => {
    setGrokDeliverer(() => ({ spoken: true, textToo: true }));
    await deliverReply(
      { ...dmTurn, text: "Both done.", grok: { msgGuids: requests, alsoText: false } },
      config,
      echoes,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("with no Grok channel registered the reply still reaches the person", async () => {
    const res = await deliverReply(
      { ...dmTurn, text: "hello", grok: { msgGuids: requests, alsoText: false } },
      config,
      echoes,
    );
    expect(res.sent).toBe(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("a reply that sanitizes to nothing is silenced, and no one on the line is asked", async () => {
    const deliverer = mock(() => ({ spoken: true, textToo: false }));
    setGrokDeliverer(deliverer);
    const res = await deliverReply(
      { ...dmTurn, text: "KEEP_QUIET", grok: { msgGuids: requests, alsoText: false } },
      config,
      echoes,
    );
    expect(res.silenced).toBe(true);
    expect(deliverer).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("deliverReply on every other turn in the same session", () => {
  test("an ordinary text's reply never reaches the Grok deliverer, even with one registered and a request waiting", async () => {
    const deliverer = mock(() => ({ spoken: true, textToo: false }));
    setGrokDeliverer(deliverer);
    const res = await deliverReply({ ...dmTurn, text: "Sure, 3pm works." }, config, echoes);
    expect(deliverer).not.toHaveBeenCalled();
    expect(res.sent).toBe(1);
    expect(res.medium).toBeUndefined();
    const [, options] = invoke.mock.calls[0] as unknown as [string, { chat: string; text: string }];
    expect(options.chat).toBe(DM_GUID);
    expect(sent).toEqual(["Sure, 3pm works."]);
  });

  test("a cron or recovery fire (no grok field) is texted like any other", async () => {
    const deliverer = mock(() => ({ spoken: true, textToo: false }));
    setGrokDeliverer(deliverer);
    await deliverReply(
      { to: HANDLE, isGroup: false, text: "Time to leave.", sessionKey: `imessage:dm:${HANDLE}` },
      config,
      echoes,
    );
    expect(deliverer).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("a stale `grok:` guid", () => {
  // The first design stamped `grok:<handle>` on inbounds and session rows. A
  // stale row can still hand one back; it must never reach the bridge.
  test("is dropped and the reply goes down the normal DM path", async () => {
    const res = await deliverReply(
      { to: HANDLE, isGroup: false, chatGuid: `grok:${HANDLE}`, text: "hello" },
      config,
      echoes,
    );
    expect(res.sent).toBe(1);
    const [, options] = invoke.mock.calls[0] as unknown as [string, { chat: string }];
    expect(options.chat).toBe(HANDLE);
    expect(options.chat.startsWith("grok:")).toBe(false);
  });
});
