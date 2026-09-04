import { describe, expect, test } from "bun:test";
import { tradingGate } from "../../integrations/trading/src/route.ts";
import type { Config } from "../../src/config/config.ts";
import type { InboundMessage } from "../../src/imessage/types.ts";

const JORDAN = "+15550100001";
const OTHER = "+15559998888";

function cfg(over: { enabled?: boolean; handles?: string[]; triggers?: string[] } = {}): Config {
  return {
    trading: {
      enabled: over.enabled ?? true,
      handles: over.handles ?? [JORDAN, "owner@gmail.com"],
      trigger_names: over.triggers ?? ["wolf", "quant"],
    },
  } as unknown as Config;
}

function msg(over: Partial<InboundMessage>): InboundMessage {
  return {
    rowId: 1,
    msgGuid: "g",
    chatIdentifier: JORDAN,
    chatGuid: `iMessage;-;${JORDAN}`,
    isGroup: false,
    fromHandle: JORDAN,
    fromMe: false,
    text: "hi",
    timestampMs: 0,
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
    ...over,
  };
}

/** Minimal StateStore stand-in: just the cursor KV tradingGate uses. */
function fakeState() {
  const kv = new Map<string, number>();
  return {
    getCursor: (name: string, fallback: number) => kv.get(name) ?? fallback,
    setCursor: (name: string, value: number) => kv.set(name, value),
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any;
}

describe("tradingGate — owner-only, DM-only", () => {
  test("group message from the owner NEVER routes to trading", () => {
    const s = fakeState();
    const r = tradingGate(
      msg({ isGroup: true, text: "wolf, buy AAPL", chatGuid: "iMessage;+;groupguid" }),
      cfg(),
      s,
    );
    expect(r.route).toBe("normal");
  });

  test("group trigger never leaks into later DM routing", () => {
    const s = fakeState();
    tradingGate(msg({ isGroup: true, text: "wolf hello" }), cfg(), s);
    const r = tradingGate(msg({ text: "what's my balance" }), cfg(), s);
    expect(r.route).toBe("normal");
  });

  test("DM from a non-owner never routes to trading, even with the trigger", () => {
    const s = fakeState();
    const r = tradingGate(msg({ fromHandle: OTHER, text: "wolf, buy TSLA" }), cfg(), s);
    expect(r.route).toBe("normal");
  });

  test("DM from owner with trigger routes to trading", () => {
    const s = fakeState();
    const r = tradingGate(msg({ text: "wolf, how are we doing?" }), cfg(), s);
    expect(r.route).toBe("trading");
  });

  test("routing is per-message: no stickiness after a trigger", () => {
    const s = fakeState();
    expect(tradingGate(msg({ text: "wolf buy AAPL" }), cfg(), s).route).toBe("trading");
    // The very next message without the name goes straight back to edmund.
    expect(tradingGate(msg({ text: "and how much cash is left?" }), cfg(), s).route).toBe("normal");
    expect(tradingGate(msg({ text: "Howdy" }), cfg(), s).route).toBe("normal");
    expect(tradingGate(msg({ text: "wolf status" }), cfg(), s).route).toBe("trading");
  });

  test("a legacy sticky flag from the old router is cleared, not honored", () => {
    const s = fakeState();
    s.setCursor(`trading_sticky:${JORDAN}`, 1);
    expect(tradingGate(msg({ text: "Howdy" }), cfg(), s).route).toBe("normal");
    expect(s.getCursor(`trading_sticky:${JORDAN}`, 0)).toBe(0);
  });

  test("owner DM with no trigger stays normal (edmund)", () => {
    const s = fakeState();
    expect(tradingGate(msg({ text: "hey what's up" }), cfg(), s).route).toBe("normal");
  });

  test("disabled trading never routes", () => {
    const s = fakeState();
    expect(tradingGate(msg({ text: "wolf buy AAPL" }), cfg({ enabled: false }), s).route).toBe(
      "normal",
    );
  });

  test("empty trigger names can't hijack every message", () => {
    const s = fakeState();
    const r = tradingGate(msg({ text: "just a normal message" }), cfg({ triggers: ["", " "] }), s);
    expect(r.route).toBe("normal");
  });
});
