/**
 * The call lifecycle, end to end, against a fake provider: what gets answered,
 * what reaches the conversation, what the model is told, and what is never
 * allowed to happen (talking to the wrong person, a call on a breached Mac).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALL_SERVICE, clearVoiceBindings, voiceBindingFor } from "../src/calls/binding.ts";
import { CallManager, type CallManagerDeps } from "../src/calls/manager.ts";
import type { Permission } from "../src/calls/policy.ts";
import { CallStore } from "../src/calls/store.ts";
import type {
  CallConversation,
  CallProvider,
  CallRecord,
  Peer,
  ProviderCall,
  ProviderEvent,
} from "../src/calls/types.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { normalizeHandle } from "../src/sessions/key.ts";

const DANA = "+15550100001";
const FRIEND = "+15550100002";
const OTHER = "+15550100009";
const dm = (h: string) => `imessage:dm:${h}`;

class FakeProvider implements CallProvider {
  readonly name = "FaceTime";
  emit: (event: ProviderEvent) => void = () => {};
  answered: string[] = [];
  hungUp: string[] = [];
  dialled: string[] = [];
  listening = false;
  said: { chunkId: string; text: string }[] = [];
  flushes = 0;
  async start(onEvent: (event: ProviderEvent) => void) {
    this.emit = onEvent;
  }
  async stop() {}
  async dial(handle: string): Promise<ProviderCall> {
    this.dialled.push(handle);
    return {
      id: "out_1",
      direction: "outgoing",
      state: "dialing",
      peer: { kind: "person", handle },
    };
  }
  async answer(id: string) {
    this.answered.push(id);
  }
  async hangup(id: string) {
    this.hungUp.push(id);
  }
  async listen() {
    this.listening = true;
  }
  async stopListening() {
    this.listening = false;
  }
  /** What audioReady() answers; replace with a pending promise to hold it. */
  route: Promise<{ ok: true } | { ok: false; detail: string }> = Promise.resolve({ ok: true });
  async audioReady() {
    return this.route;
  }
  async say(chunkId: string, pcm: Uint8Array) {
    this.said.push({ chunkId, text: new TextDecoder().decode(pcm) });
  }
  async flush() {
    this.flushes += 1;
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await tick(5);
  }
}

let dir: string;
let store: CallStore;
let provider: FakeProvider;
let manager: CallManager;
let routed: { key: string; msg: InboundMessage }[];
let events: { key: string; text: string }[];
let alerts: string[];
let ended: CallRecord[];
let allowed: Set<string>;
let handedOff: string[];
let expedited: string[];

function conversationFor(peer: Peer): CallConversation | null {
  if (peer.kind === "group") return null;
  const handle = normalizeHandle(peer.handle);
  return {
    sessionKey: dm(handle),
    chatGuid: `any;-;${handle}`,
    isGroup: false,
    label: handle === DANA ? "Dana" : handle,
    handles: [handle],
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "edmund-calls-mgr-"));
  store = new CallStore(dir);
  provider = new FakeProvider();
  routed = [];
  events = [];
  alerts = [];
  ended = [];
  allowed = new Set([DANA, FRIEND]);
  handedOff = [];
  expedited = [];
  const deps: CallManagerDeps = {
    settings: {
      maxCallMinutes: 30,
      ringAnswerMs: 400,
      endpointMs: 30,
      dialTimeoutMs: 400,
      pollMs: 15,
      connectSettleMs: 0,
    },
    provider,
    store,
    speaker: {
      synthesize: async (text) => ({ pcm: new TextEncoder().encode(text), sampleRate: 24_000 }),
    },
    conversationFor,
    policy: {
      permits: (target): Permission =>
        target.kind === "person" && allowed.has(normalizeHandle(target.handle))
          ? { allowed: true }
          : { allowed: false, reason: "not on the allow list" },
    },
    canon: normalizeHandle,
    routeInbound: (key, msg) => routed.push({ key, msg }),
    fireSystemEvent: (key, text) => events.push({ key, text }),
    expediteWakeUps: (key) => expedited.push(key),
    clearForCall: async () => handedOff,
    companions: [{ name: "probe", onEnd: (call) => void ended.push(call) }],
    alert: (message) => alerts.push(message),
  };
  manager = new CallManager(deps);
  await manager.start();
});

afterEach(async () => {
  await manager.stop();
  store.close();
  clearVoiceBindings();
  rmSync(dir, { recursive: true, force: true });
});

function ring(handle: string, id = "in_1") {
  provider.emit({
    type: "call",
    call: { id, direction: "incoming", state: "ringing", peer: { kind: "person", handle } },
  });
}

function connect(id: string, handle: string) {
  provider.emit({
    type: "call",
    call: { id, direction: "incoming", state: "active", peer: { kind: "person", handle } },
  });
}

function hangUp(id: string, handle: string) {
  provider.emit({
    type: "call",
    call: { id, direction: "incoming", state: "ended", peer: { kind: "person", handle } },
  });
}

describe("an incoming call", () => {
  test("from someone allowed: answered once the greeting is ready, and spoken into their DM", async () => {
    ring(DANA);
    await until(() => events.some((e) => e.text.includes("is calling")));
    const binding = voiceBindingFor(dm(DANA));
    expect(binding).not.toBeNull();

    // The ring-time turn's reply arrives the way a cron reply does.
    const greeting = binding!.deliver("Hey Dana, what's up?");
    await until(() => provider.answered.length === 1);
    expect(provider.said).toEqual([]); // held until the call connects
    connect("in_1", DANA);
    expect(await greeting).toBe("spoken");
    expect(provider.said.map((s) => s.text)).toEqual(["Hey Dana, what's up?"]);
    expect(provider.listening).toBe(true);
    provider.emit({ type: "spoken", chunkId: provider.said[0]!.chunkId, played: true });

    // The caller's speech reaches the DM as a message, once they pause.
    provider.emit({ type: "heard", text: "Can you check", final: true, atMs: Date.now() });
    provider.emit({ type: "heard", text: "the weather?", final: true, atMs: Date.now() });
    await until(() => routed.length === 1);
    const { key, msg } = routed[0]!;
    expect(key).toBe(dm(DANA));
    expect(msg.text).toBe("Can you check the weather?");
    expect(msg.service).toBe(CALL_SERVICE);
    expect(msg.rowId).toBeLessThan(0);
    expect(msg.chatGuid).toBe(`any;-;${DANA}`);

    hangUp("in_1", DANA);
    await until(() => ended.length === 1);
    expect(voiceBindingFor(dm(DANA))).toBeNull();
    expect(events.at(-1)!.text).toContain("The call with Dana ended");
    const call = store.getCall(ended[0]!.id)!;
    expect(call.endReason).toBe("they hung up");
    expect(store.utterances(call.id).map((u) => u.speaker)).toEqual(["edmund", "caller"]);
  });

  test("from someone not allowed: never answered, and nothing is bound", async () => {
    allowed.clear();
    ring(DANA);
    await tick(100);
    expect(voiceBindingFor(dm(DANA))).toBeNull();
    expect(provider.answered).toEqual([]);
    expect(events).toEqual([]);
  });

  test("hung up while ringing: the greeting is dropped, and Edmund hears it was missed", async () => {
    ring(DANA);
    await until(() => events.some((e) => e.text.includes("is calling")));
    const binding = voiceBindingFor(dm(DANA))!;
    hangUp("in_1", DANA);
    await until(() => events.some((e) => e.text.includes("hung up before you picked up")));
    expect(await binding.deliver("Hey Dana!")).toBe("silent");
    expect(ended).toEqual([]);
  });

  test("work handed off at ring time is named when the call ends", async () => {
    handedOff = ["agent_7"];
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
    hangUp("in_1", DANA);
    await until(() => ended.length === 1);
    expect(events.at(-1)!.text).toContain("agent_7");
    expect(store.getCall(ended[0]!.id)!.handedOff).toEqual(["agent_7"]);
  });

  test("Edmund's voice waits until the caller can actually hear it", async () => {
    let routed!: (verdict: { ok: true }) => void;
    provider.route = new Promise((resolve) => {
      routed = resolve;
    });
    ring(DANA);
    await until(() => events.some((e) => e.text.includes("is calling")));
    const greeting = voiceBindingFor(dm(DANA))!.deliver("Hey Dana, what's up?");
    await until(() => provider.answered.length === 1);
    connect("in_1", DANA);
    await until(() => provider.listening);
    await tick(50);
    expect(provider.said).toEqual([]); // connected, but the microphone is not open yet
    routed({ ok: true });
    expect(await greeting).toBe("spoken");
    expect(provider.said.map((s) => s.text)).toEqual(["Hey Dana, what's up?"]);
  });

  test("a call the caller cannot hear Edmund on is hung up, and the operator is told why", async () => {
    provider.route = Promise.resolve({
      ok: false,
      detail: "FaceTime is listening on BlackHole 2ch, not Edmund Mic",
    });
    ring(DANA);
    await until(() => events.some((e) => e.text.includes("is calling")));
    const greeting = voiceBindingFor(dm(DANA))!.deliver("Hey Dana, what's up?");
    await until(() => provider.answered.length === 1);
    connect("in_1", DANA);
    await until(() => provider.hungUp.length === 1);
    expect(alerts.join(" ")).toContain("listening on BlackHole 2ch");
    await until(() => ended.length === 1);
    expect(store.getCall(ended[0]!.id)!.endReason).toBe("the caller could not hear Edmund");
    expect(provider.said).toEqual([]);
    // The greeting nobody heard goes out as a text instead of vanishing.
    expect(await greeting).toBe("unavailable");
  });

  test("talking over Edmund stops him", async () => {
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
    const binding = voiceBindingFor(dm(DANA))!;
    binding.onTurnStarted("t1");
    binding.onTextDelta("t1", "So the forecast for tomorrow is sunny and warm. And");
    await until(() => provider.said.length === 1);
    provider.emit({ type: "heard", text: "wait wait", final: false, atMs: Date.now() });
    await until(() => provider.flushes === 1);
  });
});

describe("agent results on a call", () => {
  test("while the call is up, its conversation's completions are fired at once", async () => {
    ring(DANA);
    await tick(50);
    expect(expedited).toEqual([]); // not while it only rings
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => expedited.includes(dm(DANA)));
    hangUp("in_1", DANA);
    await until(() => ended.length === 1);
    const after = expedited.length;
    await tick(60);
    expect(expedited.length).toBe(after); // and not after it ends
  });
});

describe("hanging up", () => {
  test("end_call waits for the goodbye to finish playing, then hangs up", async () => {
    // The first live call hung up the instant end_call ran, mid-sentence.
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
    const binding = voiceBindingFor(dm(DANA))!;
    binding.onTurnStarted("t1");
    binding.onTextDelta("t1", "Okay, talk soon. Bye");
    store.addCommand("cmd_1", dm(DANA), "hangup");
    await until(() => provider.said.length === 2);
    await tick(100);
    expect(provider.hungUp).toEqual([]); // still saying goodbye
    for (const s of provider.said)
      provider.emit({ type: "spoken", chunkId: s.chunkId, played: true });
    await until(() => ended.length === 1);
    expect(provider.hungUp).toEqual(["in_1"]);
    expect(store.getCall(ended[0]!.id)!.endReason).toBe("Edmund hung up");
  });

  test("speech still queued when a call ends is dropped, not played into the dead line", async () => {
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
    const before = provider.flushes;
    hangUp("in_1", DANA);
    await until(() => ended.length === 1);
    expect(provider.flushes).toBe(before + 1);
  });
});

describe("an outgoing call", () => {
  function request(handle: string, requestedBy = dm(handle)) {
    store.addRequest({
      id: `req_${handle}`,
      requestedBy,
      sessionKey: dm(handle),
      handle,
      reason: "the package arrived",
      createdAtMs: Date.now(),
    });
  }

  test("dials, and once the right person picks up Edmund opens with why he called", async () => {
    request(FRIEND, dm(DANA));
    await until(() => provider.dialled.length === 1);
    connect("out_1", FRIEND);
    await until(() => events.some((e) => e.text.includes("picked up")));
    const opened = events.find((e) => e.text.includes("picked up"))!;
    expect(opened.key).toBe(dm(FRIEND));
    expect(opened.text).toContain("the package arrived");

    store.addCommand("cmd_1", dm(FRIEND), "hangup");
    await until(() => provider.hungUp.length === 1);
    await until(() => ended.length === 1);
    // The person who asked hears how it went.
    expect(events.some((e) => e.key === dm(DANA) && e.text.includes("ended after"))).toBe(true);
  });

  test("connected to anyone else, it hangs up at once and alerts", async () => {
    request(FRIEND);
    await until(() => provider.dialled.length === 1);
    connect("out_1", OTHER);
    await until(() => provider.hungUp.length === 1);
    expect(alerts.join(" ")).toContain("instead of");
    expect(events.some((e) => e.text.includes("picked up"))).toBe(false);
    expect(voiceBindingFor(dm(FRIEND))).toBeNull();
  });

  test("a request the policy refuses is never dialled, and the requester is told", async () => {
    allowed.delete(FRIEND);
    request(FRIEND, dm(DANA));
    await until(() => events.length === 1);
    expect(provider.dialled).toEqual([]);
    expect(events[0]).toEqual({
      key: dm(DANA),
      text: expect.stringContaining("Couldn't place that call"),
    });
  });

  test("unanswered, it gives up and says so", async () => {
    request(FRIEND);
    await until(() => provider.hungUp.length === 1, 2_000);
    expect(events.at(-1)!.text).toContain("didn't pick up");
  });
});

describe("silence", () => {
  test("if the Mac becomes audible mid-call, the call ends and the operator is told", async () => {
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
    provider.emit({ type: "silence-breach", device: "Mac mini Speakers", detail: "unmuted" });
    await until(() => provider.hungUp.length === 1);
    expect(alerts.join(" ")).toContain("Mac mini Speakers");
  });
});
