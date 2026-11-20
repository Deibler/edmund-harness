/**
 * The call lifecycle, end to end, against a fake provider: what gets answered,
 * what reaches the conversation, what the model is told, and what is never
 * allowed to happen (talking to the wrong person, a call on a breached Mac).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CALL_SERVICE,
  anyVoiceLive,
  clearVoiceBindings,
  voiceBindingFor,
} from "../src/calls/binding.ts";
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
  constructor(readonly name = "FaceTime") {}
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
  /** What canHear() answers; a pending promise holds it. */
  hearing:
    | { ok: true }
    | { ok: false; detail: string }
    | Promise<{ ok: true } | { ok: false; detail: string }> = { ok: true };
  async canHear() {
    return this.hearing;
  }
  listens = 0;
  async listen() {
    this.listening = true;
    this.listens += 1;
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
/** A second, answer-only provider (the voice lab). */
let lab: FakeProvider;
let manager: CallManager;
let deps: CallManagerDeps;
let routed: { key: string; msg: InboundMessage }[];
let events: { key: string; text: string }[];
/** Sessions made reachable and events fired, in the order they happened. */
let order: string[];
let alerts: string[];
let ended: CallRecord[];
let allowed: Set<string>;
let handedOff: string[];
let expedited: string[];
let warmed: number;
let prepared: number;

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
  lab = new FakeProvider("voice lab");
  routed = [];
  events = [];
  order = [];
  alerts = [];
  ended = [];
  allowed = new Set([DANA, FRIEND]);
  handedOff = [];
  expedited = [];
  warmed = 0;
  prepared = 0;
  deps = {
    settings: {
      maxCallMinutes: 30,
      ringAnswerMs: 400,
      endpointMs: 30,
      dialTimeoutMs: 400,
      pollMs: 15,
      connectSettleMs: 0,
      turnThreshold: 0.5,
      turnCompleteGraceMs: 10,
      turnIncompleteWaitMs: 300,
      turnPunctuatedWaitMs: 40,
      hesitationHoldMs: 400,
      holdReleaseMs: 100,
      // Off unless a test turns them on: each is its own subject below.
      openerLine: "",
      openerGraceMs: 40,
      thinkingSounds: [],
      thinkingAfterMs: 0,
      quietCheckMs: 0,
    },
    provider,
    inboundProviders: [lab],
    store,
    speaker: {
      synthesize: async (text) => ({ pcm: new TextEncoder().encode(text), sampleRate: 24_000 }),
      warm: () => void warmed++,
    },
    prepareToHear: () => void prepared++,
    conversationFor,
    ensureConversation: (conversation) => order.push(`ensure ${conversation.sessionKey}`),
    policy: {
      permits: (target): Permission =>
        target.kind === "person" && allowed.has(normalizeHandle(target.handle))
          ? { allowed: true }
          : { allowed: false, reason: "not on the allow list" },
    },
    canon: normalizeHandle,
    routeInbound: (key, msg) => routed.push({ key, msg }),
    fireSystemEvent: (key, text) => {
      events.push({ key, text });
      order.push(`event ${key}`);
    },
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

function ring(handle: string, id = "in_1", on: FakeProvider = provider) {
  on.emit({
    type: "call",
    call: { id, direction: "incoming", state: "ringing", peer: { kind: "person", handle } },
  });
}

function connect(id: string, handle: string, on: FakeProvider = provider) {
  on.emit({
    type: "call",
    call: { id, direction: "incoming", state: "active", peer: { kind: "person", handle } },
  });
}

function hangUp(id: string, handle: string, on: FakeProvider = provider) {
  on.emit({
    type: "call",
    call: { id, direction: "incoming", state: "ended", peer: { kind: "person", handle } },
  });
}

describe("an incoming call", () => {
  test("the conversation is made reachable before its greeting is asked for", async () => {
    ring(DANA);
    await until(() => events.some((e) => e.text.includes("is calling")));
    const ensured = order.indexOf(`ensure ${dm(DANA)}`);
    expect(ensured).toBeGreaterThanOrEqual(0);
    expect(ensured).toBeLessThan(order.indexOf(`event ${dm(DANA)}`));
  });

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

describe("a second provider", () => {
  test("a call is served start to finish by the provider it came in on", async () => {
    ring(DANA, "lab_1", lab);
    await until(() => events.some((e) => e.text.startsWith("[voice lab] Dana is calling")));
    await until(() => lab.answered.length === 1, 1_000);
    expect(provider.answered).toEqual([]);
    connect("lab_1", DANA, lab);
    await until(() => lab.listening);
    expect(provider.listening).toBe(false);

    // Hearing from the other provider is not this call's.
    provider.emit({ type: "heard", text: "not this call", final: true, atMs: Date.now() });
    lab.emit({ type: "heard", text: "hello from the lab", final: true, atMs: Date.now() });
    await until(() => routed.length === 1);
    await tick(50);
    expect(routed.map((r) => r.msg.text)).toEqual(["hello from the lab"]);

    hangUp("lab_1", DANA, lab);
    await until(() => ended.length === 1);
    expect(ended[0]!.provider).toBe("voice lab");
    expect(events.at(-1)!.text).toStartWith("[voice lab] The call with Dana ended");
    expect(lab.flushes).toBeGreaterThan(0);
    expect(provider.flushes).toBe(0);
  });

  test("a ring Edmund turned away on one provider does not take over the next call on another", async () => {
    // A caller who is not allowed is left ringing on FaceTime...
    ring(OTHER, "ft_spam");
    await tick(30);
    // ...while the operator calls from the lab.
    ring(DANA, "lab_1", lab);
    await until(() => lab.answered.length === 1, 1_000);
    expect(lab.answered).toEqual(["lab_1"]);
    expect(provider.answered).toEqual([]);
    connect("lab_1", DANA, lab);
    await until(() => lab.listening);

    // A FaceTime call while the lab call is up is not answered.
    ring(FRIEND, "ft_2");
    await tick(100);
    expect(provider.answered).toEqual([]);
    // And the FaceTime caller hanging up does not end the lab call.
    hangUp("ft_2", FRIEND);
    await tick(30);
    expect(manager.current()?.provider).toBe("voice lab");
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

describe("turn-taking", () => {
  async function onCall() {
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
  }
  const pause = (probability: number | null) =>
    provider.emit({ type: "pause", stoppedAtMs: Date.now(), probability });
  const final = (text: string) =>
    provider.emit({ type: "heard", text, final: true, atMs: Date.now() });

  test("a pause that sounds finished ends the turn", async () => {
    await onCall();
    pause(0.92);
    final("That's all I wanted.");
    await until(() => routed.length === 1);
    expect(routed[0]!.msg.text).toBe("That's all I wanted.");
  });

  test("a pause mid-thought keeps listening, so what follows is one message, not two", async () => {
    // Answering every pause in turn made calls feel like a queue: a, then b.
    await onCall();
    pause(0.1);
    final("So I was thinking");
    await tick(100);
    expect(routed).toEqual([]); // still their turn
    provider.emit({ type: "speech", talking: true, atMs: Date.now() });
    final("we could go tomorrow.");
    pause(0.9);
    await until(() => routed.length === 1);
    expect(routed[0]!.msg.text).toBe("So I was thinking we could go tomorrow.");
    await tick(50);
    expect(routed.length).toBe(1);
  });

  test("an unfinished pause still ends the turn if they stay quiet", async () => {
    await onCall();
    pause(0.1);
    final("Hmm, let me think");
    await until(() => routed.length === 1, 1_000);
  });

  test("without a verdict, the silence timer decides, as before", async () => {
    await onCall();
    pause(null);
    final("Hello?");
    await until(() => routed.length === 1);
  });

  test("talking again before Edmund answered: once they take their turn, that reply goes unsaid and the next turn knows", async () => {
    await onCall();
    const binding = voiceBindingFor(dm(DANA))!;
    binding.onTurnStarted("t1");
    provider.emit({ type: "heard", text: "and also", final: false, atMs: Date.now() });
    expect(await binding.deliver("The store closes at nine.", "t1")).toBe("silent");
    binding.onTurnSettled("t1", "delivered");
    final("and also the pharmacy.");
    pause(0.9);
    await until(() => routed.length === 1);
    await tick(150); // past the hold: still unsaid, because they took their turn
    expect(provider.said).toEqual([]);
    expect(binding.envelopeBlock()).toContain("They kept talking before you answered");
    expect(binding.envelopeBlock()).not.toContain("kept talking"); // told once
  });

  test("talk that never becomes their turn (someone in the background) does not silence him", async () => {
    // 2026-10-29: background talk cancelled his reply, never became a turn,
    // and the caller sat in 18 s of silence.
    await onCall();
    const binding = voiceBindingFor(dm(DANA))!;
    binding.onTurnStarted("t1");
    provider.emit({ type: "heard", text: "is that him", final: false, atMs: Date.now() });
    expect(await binding.deliver("Glad it works now.", "t1")).toBe("silent");
    binding.onTurnSettled("t1", "delivered");
    await until(() => provider.said.length === 1);
    expect(provider.said[0]!.text).toBe("Glad it works now.");
    expect(routed).toEqual([]);
  });

  test("a final transcript with no words is not a turn", async () => {
    await onCall();
    final(".");
    await tick(100);
    expect(routed).toEqual([]);
  });
});

describe("a call that connects before the opening line is written", () => {
  // 2026-11-11: he picked up to 10 s of nothing. Incoming calls are answered
  // at a deadline whether the greeting is ready or not, which was 1.5-4 s of
  // nothing on most of them.
  test("says hello into the silence, and the next turn is told it was said", async () => {
    deps.settings.openerLine = "Hello?";
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000); // answered at the deadline, greeting unwritten
    expect(provider.said).toEqual([]);
    connect("in_1", DANA);
    await until(() => provider.said.length === 1);
    expect(provider.said[0]!.text).toBe("Hello?");
    const block = voiceBindingFor(dm(DANA))!.envelopeBlock();
    expect(block).toContain('the line said "Hello?" first');
    expect(voiceBindingFor(dm(DANA))!.envelopeBlock()).not.toContain('said "Hello?"'); // told once
  });

  test("says nothing extra when his own line is ready", async () => {
    deps.settings.openerLine = "Hello?";
    ring(DANA);
    await until(() => events.some((e) => e.text.includes("is calling")));
    void voiceBindingFor(dm(DANA))!.deliver("Hey Dana, what's up?");
    await until(() => provider.answered.length === 1);
    connect("in_1", DANA);
    await until(() => provider.said.length === 1);
    await tick(120);
    expect(provider.said.map((s) => s.text)).toEqual(["Hey Dana, what's up?"]);
  });

  test("does not say hello over a caller who spoke first", async () => {
    deps.settings.openerLine = "Hello?";
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
    provider.emit({ type: "speech", talking: true, atMs: Date.now() });
    await tick(120);
    expect(provider.said).toEqual([]);
  });
});

describe("while a reply is slow to come", () => {
  async function onCall() {
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
  }
  // Exactly as the ear sends a stretch of speech: it started, then its pause
  // and its words together. It never says they stopped talking (see the ear's
  // own tests): on the first live calls after this was written, a state that
  // waited for that kept every sound of thinking and every quiet check from
  // ever happening.
  const say = (text: string) => {
    provider.emit({ type: "speech", talking: true, atMs: Date.now() });
    provider.emit({ type: "pause", stoppedAtMs: Date.now(), probability: 0.95 });
    provider.emit({ type: "heard", text, final: true, atMs: Date.now() });
  };

  test("a sound of thinking is said, then the reply, and the gap is still measured to the reply", async () => {
    deps.settings.thinkingSounds = ["Hmm."];
    deps.settings.thinkingAfterMs = 60;
    const exchanges: Record<string, number | string>[] = [];
    deps.onExchange = (_call, fields) => exchanges.push(fields);
    await onCall();
    say("What should I make for dinner tonight?");
    await until(() => routed.length === 1);
    await until(() => provider.said.length === 1, 1_000);
    expect(provider.said[0]!.text).toBe("Hmm.");
    expect(exchanges).toEqual([]); // a hmm is not his reply

    const binding = voiceBindingFor(dm(DANA))!;
    binding.onTurnStarted("t1");
    binding.onTextDelta("t1", "Tacos. ");
    await binding.deliver("Tacos.", "t1");
    binding.onTurnSettled("t1", "delivered");
    expect(provider.said.map((s) => s.text)).toEqual(["Hmm.", "Tacos."]);
    expect(exchanges).toHaveLength(1);
    // Recorded beside the reply, never as it (both can land in one millisecond).
    expect(Number(exchanges[0]!.aside_ms)).toBeLessThanOrEqual(Number(exchanges[0]!.sound_ms));
    expect(exchanges[0]!.gap_ms).toBe(exchanges[0]!.sound_ms);
  });

  test("nothing is said once his words are on their way", async () => {
    deps.settings.thinkingSounds = ["Hmm."];
    deps.settings.thinkingAfterMs = 80;
    await onCall();
    say("What should I make for dinner tonight?");
    await until(() => routed.length === 1);
    const binding = voiceBindingFor(dm(DANA))!;
    binding.onTurnStarted("t1");
    binding.onTextDelta("t1", "How about");
    await tick(400);
    expect(provider.said).toEqual([]);
  });

  test("a word or two from them gets no sound of thinking, and neither does a reply that will not come", async () => {
    deps.settings.thinkingSounds = ["Hmm."];
    deps.settings.thinkingAfterMs = 60;
    await onCall();
    say("Okay, bye.");
    await until(() => routed.length === 1);
    await tick(400);
    expect(provider.said).toEqual([]);

    say("That was everything I wanted to tell you.");
    await until(() => routed.length === 2);
    const binding = voiceBindingFor(dm(DANA))!;
    binding.onTurnStarted("t2");
    binding.onTurnSettled("t2", "silent"); // he chose to say nothing
    await tick(400);
    expect(provider.said).toEqual([]);
  });

  test("never the same sound twice running", async () => {
    deps.settings.thinkingSounds = ["Hmm.", "Let's see."];
    deps.settings.thinkingAfterMs = 60;
    await onCall();
    const binding = voiceBindingFor(dm(DANA))!;
    for (let turn = 1; turn <= 4; turn++) {
      say("What should I make for dinner tonight?");
      await until(() => routed.length === turn);
      await until(() => provider.said.length === turn, 1_000);
      provider.emit({ type: "spoken", chunkId: provider.said[turn - 1]!.chunkId, played: true });
      binding.onTurnStarted(`t${turn}`);
      binding.onTurnSettled(`t${turn}`, "silent");
    }
    const sounds = provider.said.map((s) => s.text);
    for (let i = 1; i < sounds.length; i++) expect(sounds[i]).not.toBe(sounds[i - 1]);
  });
});

describe("listening noises", () => {
  async function talking() {
    ring(DANA);
    await until(() => events.some((e) => e.text.includes("is calling")));
    void voiceBindingFor(dm(DANA))!.deliver("So the plan for Saturday is to leave at eight.");
    await until(() => provider.answered.length === 1);
    connect("in_1", DANA);
    await until(() => provider.said.length === 1); // Edmund is speaking: nothing reported played yet
  }

  test('"uh-huh" over Edmund does not stop him', async () => {
    await talking();
    provider.emit({ type: "heard", text: "Uh huh", final: false, atMs: Date.now() });
    provider.emit({ type: "heard", text: "Yeah, okay", final: false, atMs: Date.now() });
    await tick(30);
    expect(provider.flushes).toBe(0);
  });

  test("real words over him still do, and so does a single stop", async () => {
    await talking();
    provider.emit({ type: "heard", text: "Stop.", final: false, atMs: Date.now() });
    await until(() => provider.flushes === 1);
    provider.emit({ type: "heard", text: "no not Saturday", final: false, atMs: Date.now() });
    await until(() => provider.flushes === 2);
  });

  test('"yeah" while he is still speaking is not a turn until he has stopped', async () => {
    await talking();
    provider.emit({ type: "pause", stoppedAtMs: Date.now(), probability: 0.9 });
    provider.emit({ type: "heard", text: "Yeah.", final: true, atMs: Date.now() });
    await tick(200);
    expect(routed).toEqual([]); // he is mid-sentence: nothing for him to answer yet
    provider.emit({ type: "spoken", chunkId: provider.said[0]!.chunkId, played: true });
    await until(() => routed.length === 1, 1_000); // he asked, they answered: it reaches him
    expect(routed[0]!.msg.text).toBe("Yeah.");
  });

  test("and it joins what they say next", async () => {
    await talking();
    provider.emit({ type: "heard", text: "Yeah.", final: true, atMs: Date.now() });
    provider.emit({ type: "spoken", chunkId: provider.said[0]!.chunkId, played: true });
    provider.emit({ type: "speech", talking: true, atMs: Date.now() });
    provider.emit({ type: "pause", stoppedAtMs: Date.now(), probability: 0.9 });
    provider.emit({ type: "heard", text: "What time again?", final: true, atMs: Date.now() });
    await until(() => routed.length === 1);
    expect(routed[0]!.msg.text).toBe("Yeah. What time again?");
  });
});

describe("a call that must not stay live for good", () => {
  // A live call holds back the daemon's own restart and refuses every other
  // call, so nothing may leave one "live" with nobody on it.
  test("answered but never reported connected: given up on, and hung up", async () => {
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    expect(manager.current()).not.toBeNull();
    await until(() => manager.current() === null, 1_500); // dialTimeoutMs after answering
    expect(provider.hungUp).toEqual(["in_1"]);
    expect(anyVoiceLive()).toBe(false);
  });

  test("ends, and lets go of the conversation, even if their last words cannot be handed over", async () => {
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
    deps.routeInbound = () => {
      throw new Error("pipeline is gone");
    };
    provider.emit({ type: "heard", text: "One more thing", final: true, atMs: Date.now() });
    hangUp("in_1", DANA);
    await until(() => manager.current() === null);
    await until(() => ended.length === 1);
    expect(anyVoiceLive()).toBe(false);
    expect(voiceBindingFor(dm(DANA))).toBeNull();
  });
});

describe("a call gone quiet", () => {
  async function onCall() {
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
  }
  const quietEvents = () => events.filter((e) => e.text.includes("It has been quiet"));

  test("Edmund is told, each time after twice as long, and then no more", async () => {
    deps.settings.quietCheckMs = 60;
    await onCall();
    await until(() => quietEvents().length === 1, 1_000);
    expect(quietEvents()[0]!.key).toBe(dm(DANA));
    expect(quietEvents()[0]!.text).toContain("end_call");
    const firstAt = Date.now();
    await until(() => quietEvents().length === 2, 1_500);
    expect(Date.now() - firstAt).toBeGreaterThanOrEqual(100); // twice the first wait
    await until(() => quietEvents().length === 4, 3_000);
    expect(quietEvents()[3]!.text).toContain("will not be told about the quiet again");
    await tick(700);
    expect(quietEvents()).toHaveLength(4);
  });

  test("not while they are talking or a reply is owed, and their voice starts the count over", async () => {
    deps.settings.quietCheckMs = 80;
    await onCall();
    provider.emit({ type: "speech", talking: true, atMs: Date.now() });
    await tick(300);
    expect(quietEvents()).toEqual([]);
    // The ear never reports that they stopped: the pause is how it says so.
    provider.emit({ type: "pause", stoppedAtMs: Date.now(), probability: 0.9 });
    provider.emit({
      type: "heard",
      text: "Give me one second here.",
      final: true,
      atMs: Date.now(),
    });
    await until(() => routed.length === 1);
    await tick(300); // a reply is owed: the quiet is his, not theirs
    expect(quietEvents()).toEqual([]);
    const binding = voiceBindingFor(dm(DANA))!;
    binding.onTurnStarted("t1");
    binding.onTurnSettled("t1", "silent");
    await until(() => quietEvents().length === 1, 1_000);
  });
});

describe("a second opinion on the turn detector", () => {
  async function onCall() {
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listening);
  }
  const stretch = (text: string, probability: number) => {
    provider.emit({ type: "speech", talking: true, atMs: Date.now() });
    provider.emit({ type: "pause", stoppedAtMs: Date.now(), probability });
    provider.emit({ type: "heard", text, final: true, atMs: Date.now() });
  };

  // 2026-11-12: four finished sentences in one call scored 0.03-0.05, and
  // each waited out the full unfinished-pause time before Edmund could answer.
  test("scored unfinished but transcribed as a finished sentence: handed over after the short wait", async () => {
    await onCall();
    const started = Date.now();
    stretch("So I think we fixed it.", 0.05);
    await until(() => routed.length === 1);
    expect(Date.now() - started).toBeLessThan(200); // not the 300 ms unfinished wait
  });

  test("scored unfinished and it reads unfinished too: the full wait", async () => {
    await onCall();
    stretch("because you kind of have been pausing. Before", 0.02);
    await tick(200);
    expect(routed).toEqual([]);
    await until(() => routed.length === 1, 1_000);
  });

  test('"uh" is someone about to speak, not a turn: what follows is one message', async () => {
    await onCall();
    stretch("Uh", 0.9);
    await tick(250);
    expect(routed).toEqual([]);
    stretch("Try another.", 0.9);
    await until(() => routed.length === 1);
    expect(routed[0]!.msg.text).toBe("Uh Try another.");
  });

  test('"uh" and then nothing is handed over after all, so Edmund can ask', async () => {
    await onCall();
    stretch("Uh", 0.9);
    await tick(250);
    expect(routed).toEqual([]);
    await until(() => routed.length === 1, 1_000);
    expect(routed[0]!.msg.text).toBe("Uh");
  });
});

describe("hearing", () => {
  const DEAF = { ok: false as const, detail: "permission undecided" };

  test("a call Edmund could not hear is left ringing, and the operator is told", async () => {
    provider.hearing = DEAF;
    ring(DANA);
    await until(() => alerts.length === 1);
    await tick(50);
    expect(provider.answered).toEqual([]);
    expect(alerts[0]).toContain("did not answer");
    expect(alerts[0]).toContain("permission undecided");
    expect(manager.current()).toBeNull();
  });

  test("a call Edmund could not hear is never dialled, and he is told why", async () => {
    provider.hearing = DEAF;
    store.addRequest({
      id: "req_deaf",
      requestedBy: dm(FRIEND),
      sessionKey: dm(FRIEND),
      handle: FRIEND,
      reason: "the package arrived",
      createdAtMs: Date.now(),
    });
    await until(() => events.length === 1);
    expect(provider.dialled).toEqual([]);
    expect(events[0]!.text).toContain("Couldn't place that call");
    expect(events[0]!.text).toContain("permission undecided");
    expect(alerts.join(" ")).toContain("did not call");
  });

  test("a second call that rings while the first one's hearing is asked is not answered", async () => {
    let heard!: (value: { ok: true }) => void;
    provider.hearing = new Promise((resolve) => {
      heard = resolve;
    });
    ring(DANA, "in_1");
    ring(FRIEND, "in_2");
    await tick(20);
    heard({ ok: true });
    await until(() => provider.answered.length === 1, 1_000);
    await tick(100);
    expect(provider.answered).toEqual(["in_1"]);
    expect(manager.current()?.conversation.label).toBe("Dana");
  });

  test("hearing that fails mid-call ends the call at once and the operator is told", async () => {
    ring(DANA);
    await until(() => provider.answered.length === 1, 1_000);
    connect("in_1", DANA);
    await until(() => provider.listens === 1);
    provider.emit({ type: "hearing-failed", detail: "call tap: AudioDeviceStart failed (-1)" });
    await until(() => provider.hungUp.length === 1);
    expect(alerts.join(" ")).toContain("stopped hearing them");
    // Not tried again: nothing on the path holds state a restart would clear.
    expect(provider.listens).toBe(1);
  });
});

describe("starting", () => {
  test("a call the last run left open is ended, not left in progress", async () => {
    // A daemon killed mid-call never ends its row, and call_voice and
    // call_status take an open row for a live call.
    store.createCall(
      {
        id: "call_left_open",
        provider: "FaceTime",
        direction: "inbound",
        conversation: conversationFor({ kind: "person", handle: DANA })!,
        requestedBy: null,
        reason: null,
        startedAtMs: Date.now() - 60_000,
        answeredAtMs: null,
        endedAtMs: null,
        endReason: null,
        handedOff: [],
      },
      null,
    );
    const next = new CallManager(deps);
    await next.start();
    await next.stop();
    expect(store.getCall("call_left_open")?.endReason).toBe("Edmund restarted");
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

  // 2026-11-06 and 11-11: Edmund called people he had never texted. They had
  // no session record, the "it is ringing, write your opening line" wake-up
  // was skipped for it, and they picked up to silence.
  test("the conversation is made reachable before its opening line is asked for", async () => {
    request(FRIEND, dm(DANA));
    await until(() => events.some((e) => e.text.includes("it is ringing")));
    const ensured = order.indexOf(`ensure ${dm(FRIEND)}`);
    expect(ensured).toBeGreaterThanOrEqual(0);
    expect(ensured).toBeLessThan(order.indexOf(`event ${dm(FRIEND)}`));
  });

  test("writes its opening line while it rings, says it the moment they pick up, and reports back", async () => {
    request(FRIEND, dm(DANA));
    await until(() => provider.dialled.length === 1);
    // Asked for while it rings: the first calls he placed waited for "picked
    // up" and left people saying "hello?" into 3-7 s of silence.
    await until(() => events.some((e) => e.text.includes("it is ringing")));
    const opener = events.find((e) => e.text.includes("it is ringing"))!;
    expect(opener.key).toBe(dm(FRIEND));
    // The call is placed and the reply is the opening line itself: told less,
    // Edmund called again and narrated what he was doing to the person.
    expect(opener.text).toContain("You have already placed a call");
    expect(opener.text).toContain("Do not call facetime_call again");
    expect(opener.text).toContain('Your note on why you are calling: "the package arrived"');
    expect(opener.text).toContain("Reply with only the words");
    expect(warmed).toBe(1);
    // Hearing is loaded while it rings, not when they first speak.
    expect(prepared).toBe(1);
    const line = voiceBindingFor(dm(FRIEND))!.deliver("Hey, your package arrived.");
    await tick(30);
    expect(provider.said).toEqual([]); // held until they answer
    connect("out_1", FRIEND);
    expect(await line).toBe("spoken");
    expect(provider.said.map((s) => s.text)).toEqual(["Hey, your package arrived."]);
    expect(events.some((e) => e.text.includes("picked up"))).toBe(false);

    store.addCommand("cmd_1", dm(FRIEND), "hangup");
    for (const s of provider.said)
      provider.emit({ type: "spoken", chunkId: s.chunkId, played: true });
    await until(() => provider.hungUp.length === 1);
    await until(() => ended.length === 1);
    // The conversation that asked is told how it went, with what was said:
    // told only that it ended, it went through the logs to find out.
    const report = events.find((e) => e.key === dm(DANA) && e.text.includes("ended after"))!;
    expect(report.text).toContain("What was said:");
    expect(report.text).toContain("You: Hey, your package arrived.");
    // And the call's own conversation is told not to report from there,
    // where anything it sends goes to the person it called.
    const after = events.find((e) => e.key === dm(FRIEND) && e.text.includes("ended after"))!;
    expect(after.text).toContain("has been given what was said");
    expect(after.text).toContain(`goes to ${FRIEND}`);
  });

  test("on a call another conversation asked for, he is told there is nothing to report", async () => {
    request(FRIEND, dm(DANA));
    await until(() => voiceBindingFor(dm(FRIEND)) !== null);
    expect(voiceBindingFor(dm(FRIEND))!.envelopeBlock()).toContain(
      "another conversation asked you to",
    );
  });

  test("on a call he was asked for by the person themselves, nothing about reporting", async () => {
    request(FRIEND);
    await until(() => voiceBindingFor(dm(FRIEND)) !== null);
    expect(voiceBindingFor(dm(FRIEND))!.envelopeBlock()).not.toContain("another conversation");
  });

  test("connected to anyone else, it hangs up at once and alerts", async () => {
    request(FRIEND);
    await until(() => provider.dialled.length === 1);
    connect("out_1", OTHER);
    await until(() => provider.hungUp.length === 1);
    expect(alerts.join(" ")).toContain("instead of");
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
