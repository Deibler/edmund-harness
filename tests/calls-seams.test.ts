/**
 * The places a call touches the ordinary turn path. Each test here pins an
 * invariant that, broken, would hurt a real conversation rather than a call:
 * texts lost from crash recovery, a call presented as a first meeting, a
 * spoken reply also texted, or a stale text spoken aloud.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const invoke = mock(() => Promise.resolve({ guid: "G1" }));
mock.module("../src/imessage/bridge/index.ts", () => ({ invoke }));

import {
  CALL_SERVICE,
  type VoiceBinding,
  type VoiceOutcome,
  bindVoice,
  callRowId,
  clearVoiceBindings,
  isCallUtterance,
} from "../src/calls/binding.ts";
import { deliverReply } from "../src/channels/deliver.ts";
import { historyBefore } from "../src/channels/history.ts";
import { SessionPipeline } from "../src/channels/pipeline.ts";
import { ConfigSchema } from "../src/config/config.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import type { EchoCache } from "../src/sessions/echo-cache.ts";
import { SessionLocks } from "../src/sessions/locks.ts";
import { StateStore } from "../src/sessions/store.ts";

const KEY = "imessage:dm:+15550100001";

function message(over: Partial<InboundMessage>): InboundMessage {
  return {
    rowId: 1,
    msgGuid: "m",
    chatIdentifier: "+15550100001",
    chatGuid: "any;-;+15550100001",
    isGroup: false,
    fromHandle: "+15550100001",
    fromMe: false,
    text: "hi",
    timestampMs: Date.now(),
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
    ...over,
  };
}

afterEach(() => {
  clearVoiceBindings();
  invoke.mockClear();
});

describe("utterance row ids", () => {
  // handleBatch clears `inbound_ack WHERE row_id <= max(batch rowIds)` once a
  // turn disposes of its batch. An utterance's id must never raise that max,
  // or a call turn would erase the crash-recovery record of every real text
  // that arrived during the call.
  test("a call turn's batch cannot clear the acks of texts that arrived meanwhile", () => {
    const dir = mkdtempSync(join(tmpdir(), "edmund-calls-ack-"));
    const state = new StateStore(dir);
    try {
      state.writeInboundAck(4_812_000, KEY, "{}");
      state.writeInboundAck(4_812_001, KEY, "{}");
      const batch = [message({ rowId: callRowId(), service: CALL_SERVICE })];
      const max = Math.max(...batch.map((m) => m.rowId));
      if (max > 0) state.clearInboundAcks(KEY, max); // exactly as handleBatch does
      expect(state.listInboundAcks().map((a) => a.rowId)).toEqual([4_812_000, 4_812_001]);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ids are negative and distinct", () => {
    const now = Date.now();
    const a = callRowId(now);
    const b = callRowId(now);
    expect(a).toBeLessThan(0);
    expect(b).toBeLessThan(0);
    expect(a).not.toBe(b);
  });

  test("history for an utterance runs up to the latest message, not up to nothing", () => {
    expect(historyBefore({ rowId: callRowId() })).toBe(Number.MAX_SAFE_INTEGER);
    expect(historyBefore({ rowId: 4_812_000 })).toBe(4_812_000);
  });

  test("the service tag survives as the way an utterance is recognised", () => {
    expect(isCallUtterance(message({ service: CALL_SERVICE }))).toBe(true);
    expect(isCallUtterance(message({ service: "iMessage" }))).toBe(false);
  });
});

describe("pipeline windows", () => {
  test("an utterance gets the voice debounce; a text in the same conversation does not", async () => {
    const flushed: { text: string; at: number }[] = [];
    const pipeline = new SessionPipeline({
      debounceMs: 2_000,
      voiceDebounceMs: 20,
      handler: async (_key, batch) => {
        for (const m of batch) flushed.push({ text: m.text, at: Date.now() });
      },
      locks: new SessionLocks(),
    });
    const start = Date.now();
    pipeline.enqueue(KEY, message({ rowId: callRowId(), service: CALL_SERVICE, text: "spoken" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(flushed.map((f) => f.text)).toEqual(["spoken"]);
    expect(flushed[0]!.at - start).toBeLessThan(200);

    pipeline.enqueue(KEY, message({ rowId: 4_812_002, text: "typed" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(flushed.map((f) => f.text)).toEqual(["spoken"]);
    pipeline.cancelQueued(KEY);
  });
});

describe("delivery on a call", () => {
  const config = ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} });
  const echoes = { recordSent: () => {} } as unknown as EchoCache;

  function bindFake(outcome: VoiceOutcome): { spoken: string[] } {
    const spoken: string[] = [];
    const binding: VoiceBinding = {
      callId: "call_1",
      deliver: async (text) => {
        spoken.push(text);
        return outcome;
      },
      onTurnStarted: () => {},
      onTextDelta: () => {},
      onTurnSettled: () => {},
      envelopeBlock: () => "",
    };
    bindVoice(KEY, binding);
    return { spoken };
  }

  const args = {
    to: "+15550100001",
    isGroup: false,
    text: "Sounds good, talk soon.",
    chatGuid: "any;-;+15550100001",
  };

  test("a turn's reply is spoken, and nothing is texted", async () => {
    const { spoken } = bindFake("spoken");
    const result = await deliverReply({ ...args, sessionKey: KEY }, config, echoes);
    expect(result.medium).toBe("voice");
    expect(result.sent).toBe(1);
    expect(spoken).toEqual(["Sounds good, talk soon."]);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("a reply the call could not speak is texted instead", async () => {
    const { spoken } = bindFake("unavailable");
    const result = await deliverReply({ ...args, sessionKey: KEY }, config, echoes);
    expect(spoken).toHaveLength(1);
    expect(result.medium).toBeUndefined();
    expect(invoke).toHaveBeenCalled();
  });

  test("a path that names no conversation always texts, even mid-call", async () => {
    const { spoken } = bindFake("spoken");
    await deliverReply(args, config, echoes);
    expect(spoken).toEqual([]);
    expect(invoke).toHaveBeenCalled();
  });
});
