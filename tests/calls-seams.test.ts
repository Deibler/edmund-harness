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

import { ensureSessionFor } from "../src/calls/conversation.ts";
import { deliverReply } from "../src/channels/deliver.ts";
import { historyBefore } from "../src/channels/history.ts";
import { SessionPipeline } from "../src/channels/pipeline.ts";
import { ConfigSchema } from "../src/config/config.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { wakeEnvelope } from "../src/scheduler/fire.ts";
import {
  CALL_SERVICE,
  type VoiceBinding,
  type VoiceOutcome,
  bindVoice,
  callRowId,
  clearVoiceBindings,
  isCallUtterance,
  spokenSessionFor,
  voiceBindingFor,
} from "../src/sessions/call-binding.ts";
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

describe("a wake-up in a conversation on a call", () => {
  // The first turn of every call Edmund places is a wake-up ("it is ringing,
  // write your opening line"), and so are an agent's result and a quiet
  // check. They were the one kind of turn not told it was on a call.
  const job = { sessionKey: KEY, systemEvent: "[FaceTime] It is ringing." };

  test("is told it is on a call, like every other turn there", () => {
    bindVoice(KEY, {
      callId: "call_1",
      deliver: async () => "spoken" as const,
      onTurnStarted: () => {},
      onTextDelta: () => {},
      onTurnSettled: () => {},
      envelopeBlock: () => "[On a FaceTime call with Dana: it is ringing on their end]",
    });
    const lines = wakeEnvelope(job, "[Scheduled event]", null, "Recent thread").split("\n");
    expect(lines).toEqual([
      "[Scheduled event]",
      "",
      "[FaceTime] It is ringing.",
      "",
      "[On a FaceTime call with Dana: it is ringing on their end]",
      "",
      "Recent thread",
    ]);
  });

  test("off a call, it says nothing about one", () => {
    expect(wakeEnvelope(job, "[Scheduled event]", null, null)).toBe(
      "[Scheduled event]\n\n[FaceTime] It is ringing.",
    );
  });
});

describe("a call to someone never texted", () => {
  // A wake-up for a session with no record is skipped (scheduler/fire.ts), so the
  // record has to exist before the call's first event is fired at it.
  test("gets the session record its first text would have made", () => {
    const dir = mkdtempSync(join(tmpdir(), "edmund-calls-session-"));
    const state = new StateStore(dir);
    try {
      expect(state.getSession(KEY)).toBeNull();
      ensureSessionFor(
        { sessionKey: KEY, chatGuid: "", isGroup: false, label: "Dana", handles: ["+15550100001"] },
        state,
      );
      const session = state.getSession(KEY);
      expect(session).not.toBeNull();
      expect(session!.claudeSessionId).toBeNull();
      expect(session!.isGroup).toBe(0);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves an existing conversation's record alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "edmund-calls-session-"));
    const state = new StateStore(dir);
    try {
      state.upsertSession({
        sessionKey: KEY,
        claudeSessionId: "claude-session-1",
        chatGuid: "any;-;+15550100001",
        isGroup: 0,
        lastInboundMs: 5,
        lastOutboundMs: 7,
      });
      ensureSessionFor(
        { sessionKey: KEY, chatGuid: "", isGroup: false, label: "Dana", handles: ["+15550100001"] },
        state,
      );
      const session = state.getSession(KEY)!;
      expect(session.claudeSessionId).toBe("claude-session-1");
      expect(session.chatGuid).toBe("any;-;+15550100001");
      expect(session.lastOutboundMs).toBe(7);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pipeline windows", () => {
  // The call's own turn taking has already ended their turn once. Waiting
  // here as well was 250 ms of nothing before every reply on a call.
  test("an utterance is handed over at once; a text in the same conversation still waits", async () => {
    const flushed: { text: string; at: number }[] = [];
    const pipeline = new SessionPipeline({
      debounceMs: 2_000,
      voiceDebounceMs: 150,
      handler: async (_key, batch) => {
        for (const m of batch) flushed.push({ text: m.text, at: Date.now() });
      },
      locks: new SessionLocks(),
    });
    const start = Date.now();
    pipeline.enqueue(KEY, message({ rowId: callRowId(), service: CALL_SERVICE, text: "spoken" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(flushed.map((f) => f.text)).toEqual(["spoken"]);
    expect(flushed[0]!.at - start).toBeLessThan(60); // not the 150 ms voice window

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

  // "Call me" -> facetime_call -> "Calling you now.": the turn began as a
  // text conversation and its line is a text, even though the call it placed
  // is bound by the time the line is delivered.
  test("a turn that began before the call texts its reply; one that began on it speaks", async () => {
    const { spoken } = bindFake("spoken");
    const before = spokenSessionFor(KEY, null);
    await deliverReply({ ...args, text: "Calling you now.", sessionKey: before }, config, echoes);
    expect(spoken).toEqual([]);
    expect(invoke).toHaveBeenCalled();

    invoke.mockClear();
    const during = spokenSessionFor(KEY, voiceBindingFor(KEY));
    await deliverReply({ ...args, sessionKey: during }, config, echoes);
    expect(spoken).toEqual(["Sounds good, talk soon."]);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("a path that names no conversation always texts, even mid-call", async () => {
    const { spoken } = bindFake("spoken");
    await deliverReply(args, config, echoes);
    expect(spoken).toEqual([]);
    expect(invoke).toHaveBeenCalled();
  });
});
