/**
 * The one place call rules live.
 *
 * Providers report and obey; the manager decides. For every call it decides
 * which conversation it belongs to, whether it is allowed, how the session
 * is freed if Edmund is busy in it, when to pick up, what reaches the model,
 * and what happens when it ends. A second provider plugs in under the same
 * rules, and new work alongside a call is a CallCompanion, not an edit here.
 *
 * One call at a time. While it is live, its conversation's session has a
 * voice binding (binding.ts): the caller's speech arrives as messages in that
 * session, and the session's replies are spoken.
 */

import type { InboundMessage } from "../imessage/types.ts";
import type { SessionKey } from "../sessions/key.ts";
import { genId } from "../util/ids.ts";
import { log } from "../util/log.ts";
import { CALL_SERVICE, type VoiceBinding, bindVoice, callRowId, unbindVoice } from "./binding.ts";
import { callEnvelopeBlock } from "./envelope.ts";
import type { CallTarget, Permission } from "./policy.ts";
import type { CallRequest, CallStore } from "./store.ts";
import { type ExchangeTrace, describeTrace, newTrace } from "./trace.ts";
import type {
  CallCompanion,
  CallConversation,
  CallProvider,
  CallRecord,
  Peer,
  ProviderCall,
  ProviderEvent,
  Speaker,
  Utterance,
} from "./types.ts";
import { VoiceOut } from "./voice-out.ts";

export type CallSettings = {
  maxCallMinutes: number;
  ringAnswerMs: number;
  endpointMs: number;
  /**
   * How long after the provider reports the call's audio ready before
   * Edmund's voice is sent. Readiness itself is measured, not waited out:
   * FaceTime's microphone opens about 2.4 s after the call reports active
   * (2026-10-29), and anything sent before that is lost.
   */
  connectSettleMs: number;
  /**
   * Turn-taking from the turn detector's verdict on each pause. At or above
   * `turnThreshold` the caller has finished: the turn ends once their final
   * transcript is in, after `turnCompleteGraceMs`. Below it they are mid-
   * thought ("and then...", "um"), and Edmund keeps listening for up to
   * `turnIncompleteWaitMs` of quiet. With no verdict, `endpointMs` after the
   * final transcript, as before.
   */
  turnThreshold: number;
  turnCompleteGraceMs: number;
  turnIncompleteWaitMs: number;
  /** How long an outgoing call may ring before Edmund gives up. */
  dialTimeoutMs: number;
  /** How often the request and command queues are read. */
  pollMs: number;
};

export type CallManagerDeps = {
  settings: CallSettings;
  provider: CallProvider;
  store: CallStore;
  speaker: Speaker;
  conversationFor: (peer: Peer) => CallConversation | null;
  policy: { permits: (target: CallTarget) => Permission };
  canon: (handle: string) => string;
  /** Hand an utterance to its conversation exactly as a text would arrive. */
  routeInbound: (sessionKey: SessionKey, msg: InboundMessage) => void;
  /** Wake a conversation's model with a one-line event. */
  fireSystemEvent: (sessionKey: SessionKey, text: string) => void;
  /**
   * Fire the session's pending agent-completion wake-ups now, results
   * included. Texting debounces them 20 s so a burst becomes one reply; on a
   * call that was 20 s of silence before Edmund could pass a result on.
   */
  expediteWakeUps: (sessionKey: SessionKey) => void;
  /** Free a busy session for the call; returns the agents now carrying its work. */
  clearForCall: (sessionKey: SessionKey, label: string, deadlineMs: number) => Promise<string[]>;
  companions: CallCompanion[];
  alert: (message: string) => void;
  now?: () => number;
};

type Live = {
  record: CallRecord;
  providerCallId: string | null;
  phase: "ringing" | "dialing" | "active";
  /** Outgoing: the canonical handle Edmund meant to reach. */
  expectedHandle: string | null;
  requestId: string | null;
  voice: VoiceOut;
  /** Settled speech from the caller not yet handed to the conversation. */
  heard: string[];
  endpointTimer: ReturnType<typeof setTimeout> | null;
  timers: ReturnType<typeof setTimeout>[];
  /** The turn detector's verdict on the caller's latest pause; null once they talk again. */
  turnEnd: "complete" | "incomplete" | null;
  /** The exchange in progress, logged at Edmund's first sound in reply. */
  trace: ExchangeTrace;
  /** Fresh recognition sessions started because one failed mid-call. */
  hearingRestarts: number;
};

/** Two words of new speech while Edmund talks is a barge-in; a cough is not. */
const BARGE_IN_WORDS = 2;
/** Longest end_call waits for Edmund's last words to finish playing. */
const HANGUP_DRAIN_MS = 15_000;
/** Recognition restarts allowed per call before giving up on hearing it. */
const MAX_HEARING_RESTARTS = 3;

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export class CallManager {
  private readonly deps: CallManagerDeps;
  private readonly now: () => number;
  private live: Live | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(deps: CallManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    await this.deps.provider.start((event) => void this.onEvent(event));
    this.poller = setInterval(() => void this.drainQueues(), this.deps.settings.pollMs);
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.live) await this.end("Edmund shut down", { hangup: true });
    await this.deps.provider.stop();
  }

  /** The live call's conversation, if any. */
  current(): CallRecord | null {
    return this.live?.record ?? null;
  }

  // ── Events ────────────────────────────────────────────────────────────

  private async onEvent(event: ProviderEvent): Promise<void> {
    try {
      switch (event.type) {
        case "call":
          return await this.onCall(event.call);
        case "heard":
          return this.onHeard(event.text, event.final, event.spokeUntilMs);
        case "pause":
          return this.onPause(event.stoppedAtMs, event.audioMs, event.probability);
        case "speech":
          return this.onSpeech(event.talking);
        case "spoken":
          return this.live?.voice.onSpoken(event.chunkId, event.played);
        case "hearing-failed":
          return await this.onHearingFailed(event.detail);
        case "silence-breach":
          return await this.onSilenceBreach(event.device, event.detail);
        case "readiness":
          log.info("calls", `${this.deps.provider.name} ${event.ready ? "ready" : "not ready"}`, {
            detail: event.detail,
          });
          return;
      }
    } catch (err) {
      log.error("calls", "event handling failed", {
        type: event.type,
        err: (err as Error).message,
      });
    }
  }

  private async onCall(call: ProviderCall): Promise<void> {
    const live = this.live;
    if (live && call.id === live.providerCallId) {
      if (call.state === "active" && live.phase !== "active") return this.connected(live, call);
      if (call.state === "ended")
        return this.end(live.phase === "active" ? "they hung up" : "not answered");
      return;
    }
    if (call.direction === "incoming" && call.state === "ringing") {
      if (live) {
        log.info("calls", "second call ignored — already on one", { peer: call.peer });
        return;
      }
      return this.ringing(call);
    }
  }

  // ── Incoming ──────────────────────────────────────────────────────────

  private async ringing(call: ProviderCall): Promise<void> {
    if (!call.peer) {
      log.info("calls", "incoming call with no identifiable caller — not answering");
      return;
    }
    const conversation = this.deps.conversationFor(call.peer);
    if (!conversation) {
      log.info("calls", "incoming call matches no conversation — not answering", {
        peer: call.peer,
      });
      return;
    }
    const permission = this.deps.policy.permits(this.targetFor(conversation));
    if (!permission.allowed) {
      log.info("calls", "not answering", { from: conversation.label, why: permission.reason });
      return;
    }

    const live = this.begin(conversation, "incoming", { providerCallId: call.id });
    const deadline = this.now() + this.deps.settings.ringAnswerMs;
    log.info("calls", `${conversation.label} is calling`, { session: conversation.sessionKey });

    // Free the conversation if Edmund is mid-turn in it, then let him write
    // his greeting while it rings. Pick up as soon as the greeting is ready,
    // or at the deadline either way: an answered call with a beat of silence
    // beats a missed one.
    const handedOff = await this.deps.clearForCall(
      conversation.sessionKey,
      conversation.label,
      deadline,
    );
    if (this.live !== live) return;
    if (handedOff.length > 0) {
      live.record.handedOff = handedOff;
      this.deps.store.setHandedOff(live.record.id, handedOff);
    }
    this.deps.fireSystemEvent(
      conversation.sessionKey,
      `[${this.deps.provider.name}] ${conversation.label} is calling and you are picking up now. What you write is the first thing they hear: greet them the way you would answering the phone.`,
    );
    const remaining = Math.max(0, deadline - this.now());
    await Promise.race([
      live.voice.firstAudioReady(),
      new Promise((r) => setTimeout(r, remaining)),
    ]);
    if (this.live !== live) return;
    try {
      await this.deps.provider.answer(call.id);
    } catch (err) {
      log.error("calls", "answer failed", { err: (err as Error).message });
      await this.end("could not answer");
    }
  }

  // ── Outgoing ──────────────────────────────────────────────────────────

  private async drainQueues(): Promise<void> {
    try {
      if (this.live?.phase === "active") {
        this.deps.expediteWakeUps(this.live.record.conversation.sessionKey);
      }
      for (const command of this.deps.store.claimCommands(this.now())) {
        const live = this.live;
        if (
          command.command === "hangup" &&
          live?.record.conversation.sessionKey === command.sessionKey
        ) {
          // Let the goodbye finish playing first, but never hold a call open
          // on it for long.
          await live.voice.drained(HANGUP_DRAIN_MS);
          if (this.live === live) await this.end("Edmund hung up", { hangup: true });
        }
      }
      for (const request of this.deps.store.claimRequests(this.now()))
        await this.placeCall(request);
    } catch (err) {
      log.error("calls", "queue drain failed", { err: (err as Error).message });
    }
  }

  private refuse(request: CallRequest, why: string): void {
    this.deps.store.finishRequest(request.id, `refused: ${why}`);
    this.deps.fireSystemEvent(
      request.requestedBy,
      `[${this.deps.provider.name}] Couldn't place that call: ${why}.`,
    );
  }

  private async placeCall(request: CallRequest): Promise<void> {
    if (this.live) return this.refuse(request, "already on a call");
    const conversation = this.deps.conversationFor({ kind: "person", handle: request.handle });
    if (!conversation || conversation.sessionKey !== request.sessionKey) {
      return this.refuse(request, "that handle no longer resolves to the same person");
    }
    // Checked again here, where the call is placed. The tool checked too, but
    // the tool runs in another process and its check is not a boundary.
    const permission = this.deps.policy.permits(this.targetFor(conversation));
    if (!permission.allowed) return this.refuse(request, permission.reason);

    const live = this.begin(conversation, "outgoing", {
      providerCallId: null,
      expectedHandle: this.deps.canon(request.handle),
      requestId: request.id,
      requestedBy: request.requestedBy === conversation.sessionKey ? null : request.requestedBy,
      reason: request.reason,
    });
    try {
      const call = await this.deps.provider.dial(request.handle);
      live.providerCallId = call.id;
      this.deps.store.finishRequest(request.id, "dialled");
      // His opening line is written while it rings, so the conversation's
      // worker moves to the call's model and the voice is synthesised before
      // anyone answers. Waiting for "picked up" left the first people he
      // called saying "hello?" into 3-7 s of silence while all that loaded.
      const why = request.reason ? ` You are calling because: ${request.reason}` : "";
      this.deps.fireSystemEvent(
        conversation.sessionKey,
        `[${this.deps.provider.name}] You are calling ${conversation.label}; it is ringing on their end.${why} What you write now is the first thing they hear when they pick up: hello and why you called, in a sentence or two.`,
      );
      live.timers.push(
        setTimeout(() => {
          if (this.live === live && live.phase !== "active")
            void this.end("no answer", { hangup: true });
        }, this.deps.settings.dialTimeoutMs),
      );
    } catch (err) {
      this.deps.store.finishRequest(request.id, `failed: ${(err as Error).message}`);
      await this.end("could not dial");
    }
  }

  // ── Connected ─────────────────────────────────────────────────────────

  private async connected(live: Live, call: ProviderCall): Promise<void> {
    const conversation = live.record.conversation;
    // The chat_mismatch guard, for calls: a call connected to anyone other
    // than the person dialled is hung up at once, never talked through.
    if (live.expectedHandle !== null) {
      const reached = call.peer?.kind === "person" ? this.deps.canon(call.peer.handle) : null;
      if (reached !== live.expectedHandle) {
        this.deps.alert(
          `FaceTime connected to ${reached ?? "an unknown party"} instead of ${live.expectedHandle}; hung up.`,
        );
        return this.end("connected to the wrong person", { hangup: true });
      }
    }

    live.phase = "active";
    live.record.answeredAtMs = this.now();
    this.deps.store.markAnswered(live.record.id, live.record.answeredAtMs);
    await this.deps.provider.listen();
    void this.whenAudible(live);
    await this.forEachCompanion("onStart", (c) => c.onStart?.(live.record));

    const maxMs = this.deps.settings.maxCallMinutes * 60_000;
    live.timers.push(
      setTimeout(
        () =>
          this.deps.fireSystemEvent(
            conversation.sessionKey,
            `[${this.deps.provider.name}] One minute left on this call. Start wrapping up.`,
          ),
        Math.max(0, maxMs - 60_000),
      ),
      setTimeout(() => void this.end("time limit", { hangup: true }), maxMs),
    );

    log.info("calls", `on a call with ${conversation.label}`, { call: live.record.id });
  }

  /**
   * Edmund's voice is held until the caller can hear it. A call whose audio
   * never reaches them is hung up rather than left open: an answered call
   * nobody can hear sounds like a dead line, and the operator would never
   * know why.
   */
  private async whenAudible(live: Live): Promise<void> {
    const route = await this.deps.provider
      .audioReady()
      .catch((err: unknown) => ({ ok: false as const, detail: (err as Error).message }));
    if (this.live !== live) return;
    if (!route.ok) {
      this.deps.alert(
        `${this.deps.provider.name} call with ${live.record.conversation.label}: the caller could not have heard Edmund (${route.detail}); hung up.`,
      );
      return this.end("the caller could not hear Edmund", { hangup: true });
    }
    live.timers.push(
      setTimeout(() => {
        if (this.live === live) live.voice.release();
      }, this.deps.settings.connectSettleMs),
    );
  }

  // ── Hearing ───────────────────────────────────────────────────────────

  private onHeard(text: string, final: boolean, spokeUntilMs?: number): void {
    const live = this.live;
    if (!live || live.phase !== "active") return;
    if (!final) {
      if (text.trim().split(/\s+/).length >= BARGE_IN_WORDS) {
        // Talking over Edmund stops him; talking again before he has said a
        // word means his reply to the earlier part goes unsaid, and the next
        // one answers all of it.
        if (live.voice.speaking()) void live.voice.bargeIn();
        else if (live.voice.awaitingFirstWords()) live.voice.supersede();
      }
      return;
    }
    if (text.trim()) live.heard.push(text.trim());
    live.trace.finalAt = this.now();
    if (spokeUntilMs !== undefined) live.trace.stoppedAt ??= spokeUntilMs;
    if (live.turnEnd === "complete") this.armEndpoint(live, this.deps.settings.turnCompleteGraceMs);
    else if (live.turnEnd === null) this.armEndpoint(live, this.deps.settings.endpointMs);
    // Incomplete: the wait armed at the pause stands.
  }

  /** The caller paused; the turn detector has judged whether they are done. */
  private onPause(stoppedAtMs: number, audioMs: number, probability: number | null): void {
    const live = this.live;
    if (!live || live.phase !== "active" || probability === null) return;
    live.trace.stoppedAt = stoppedAtMs;
    live.trace.pausedAt = this.now();
    live.trace.probability = probability;
    if (probability >= this.deps.settings.turnThreshold) {
      live.turnEnd = "complete";
      // Their transcript settles now instead of after the recogniser's own
      // pause (1.5-2.1 s). Only at a real turn end: forced mid-sentence it
      // garbled the words either side.
      void this.deps.provider.finalizeHearing(audioMs).catch(() => {});
      if (live.heard.length > 0) this.armEndpoint(live, this.deps.settings.turnCompleteGraceMs);
    } else {
      live.turnEnd = "incomplete";
      this.armEndpoint(live, this.deps.settings.turnIncompleteWaitMs);
    }
  }

  private onSpeech(talking: boolean): void {
    const live = this.live;
    if (!live) return;
    if (talking) {
      live.turnEnd = null;
      if (live.endpointTimer) clearTimeout(live.endpointTimer);
      live.endpointTimer = null;
    } else if (live.turnEnd === null) {
      this.armEndpoint(live, this.deps.settings.endpointMs);
    }
  }

  private armEndpoint(live: Live, ms: number): void {
    if (live.endpointTimer) clearTimeout(live.endpointTimer);
    live.endpointTimer = setTimeout(() => this.flushHeard(live), ms);
  }

  /** Edmund's first sound after the caller's turn closes the exchange's trace. */
  private markSound(live: Live): void {
    const trace = live.trace;
    if (trace.handoffAt === null || trace.soundAt !== null) return;
    trace.soundAt = this.now();
    const fields = describeTrace(trace);
    if (fields) log.info("calls", "exchange", { call: live.record.id, ...fields });
    live.trace = newTrace();
  }

  /** The caller finished a turn: hand it to the conversation as a message. */
  private flushHeard(live: Live): void {
    live.endpointTimer = null;
    live.turnEnd = null;
    const text = live.heard.join(" ").trim();
    live.heard = [];
    if (!text) return;
    live.trace.handoffAt = this.now();
    const conversation = live.record.conversation;
    const atMs = this.now();
    this.record(live, { speaker: "caller", text, atMs, heard: true });
    this.deps.routeInbound(conversation.sessionKey, {
      rowId: callRowId(atMs),
      msgGuid: genId("call_utterance"),
      chatIdentifier: conversation.isGroup ? conversation.chatGuid : conversation.handles[0]!,
      chatGuid: conversation.chatGuid,
      isGroup: conversation.isGroup,
      // A group call's audio arrives mixed: who said it is not known.
      fromHandle: conversation.isGroup ? "" : conversation.handles[0]!,
      fromMe: false,
      text,
      timestampMs: atMs,
      attachments: [],
      attachmentTranscripts: {},
      service: CALL_SERVICE,
      replyToGuid: null,
    });
  }

  /**
   * Recognition died mid-call. On 2026-10-29 Apple's recogniser rejected a
   * session ("RecogRejected") two seconds into a call, which ends its
   * results, and the caller went unheard for the remaining 28 s. A fresh
   * session costs about a second. If it keeps failing, the call ends and the
   * operator hears why, rather than leaving someone talking to nobody.
   */
  private async onHearingFailed(detail: string): Promise<void> {
    const live = this.live;
    if (!live || live.phase !== "active") return;
    live.hearingRestarts += 1;
    if (live.hearingRestarts > MAX_HEARING_RESTARTS) {
      this.deps.alert(
        `${this.deps.provider.name} call with ${live.record.conversation.label}: hearing kept failing (${detail}); hung up.`,
      );
      return this.end("Edmund could not hear them", { hangup: true });
    }
    log.warn("calls", "hearing failed; starting it again", {
      call: live.record.id,
      attempt: live.hearingRestarts,
      detail,
    });
    await this.deps.provider.stopListening().catch(() => {});
    if (this.live !== live) return;
    await this.deps.provider.listen();
  }

  // ── Ending ────────────────────────────────────────────────────────────

  private async onSilenceBreach(device: string, detail: string): Promise<void> {
    this.deps.alert(`The Mac was audible on ${device} (${detail}); it has been silenced again.`);
    if (this.live) await this.end("the Mac became audible", { hangup: true });
  }

  private async end(reason: string, opts: { hangup?: boolean } = {}): Promise<void> {
    const live = this.live;
    if (!live) return;
    this.live = null;
    for (const timer of live.timers) clearTimeout(timer);
    const answered = live.record.answeredAtMs !== null;
    // Anything the caller said just before it ended still reaches the
    // conversation; with the voice gone, the reply to it is texted.
    if (live.endpointTimer) clearTimeout(live.endpointTimer);
    this.flushHeard(live);
    // A reply caught mid-way on a call that connected goes out as a text. A
    // greeting for a call that never connected is dropped: it was for a
    // conversation that did not happen.
    live.voice.close(answered ? "text" : "drop");
    // Speech already handed to the provider would otherwise keep playing into
    // a line nobody is on.
    await this.deps.provider.flush().catch(() => {});
    const conversation = live.record.conversation;
    unbindVoice(conversation.sessionKey, live.record.id);

    if (opts.hangup && live.providerCallId) {
      await this.deps.provider.hangup(live.providerCallId).catch((err: unknown) => {
        log.warn("calls", "hangup failed", { err: (err as Error).message });
      });
    }
    await this.deps.provider.stopListening().catch(() => {});
    live.record.endedAtMs = this.now();
    live.record.endReason = reason;
    this.deps.store.markEnded(live.record.id, live.record.endedAtMs, reason);
    log.info("calls", `call with ${conversation.label} ended`, { reason, call: live.record.id });

    const name = this.deps.provider.name;
    if (!answered) {
      const missed =
        live.record.direction === "incoming"
          ? `[${name}] ${conversation.label} hung up before you picked up. Text them if it seems worth it; otherwise KEEP_QUIET.`
          : `[${name}] ${conversation.label} didn't pick up (${reason}).`;
      this.deps.fireSystemEvent(live.record.requestedBy ?? conversation.sessionKey, missed);
      return;
    }

    await this.forEachCompanion("onEnd", (c) => c.onEnd?.(live.record));
    const took = duration(
      live.record.endedAtMs - (live.record.answeredAtMs ?? live.record.endedAtMs),
    );
    const lines = [
      `[${name}] The call with ${conversation.label} ended after ${took} (${reason}). You are back to texting.`,
    ];
    if (live.record.handedOff.length > 0) {
      lines.push(
        `When they called you handed your work to: ${live.record.handedOff.join(", ")}. Their results come back to you here; take it from there.`,
      );
    }
    lines.push(
      "If anything from the call needs a follow-up text, send it now; otherwise KEEP_QUIET.",
    );
    this.deps.fireSystemEvent(conversation.sessionKey, lines.join("\n"));
    if (live.record.requestedBy) {
      this.deps.fireSystemEvent(
        live.record.requestedBy,
        `[${name}] Your call with ${conversation.label} ended after ${took}.`,
      );
    }
  }

  // ── Plumbing ──────────────────────────────────────────────────────────

  private targetFor(conversation: CallConversation): CallTarget {
    return conversation.isGroup
      ? { kind: "group", chatGuid: conversation.chatGuid }
      : { kind: "person", handle: conversation.handles[0]! };
  }

  private begin(
    conversation: CallConversation,
    direction: CallRecord["direction"],
    opts: {
      providerCallId: string | null;
      expectedHandle?: string;
      requestId?: string;
      requestedBy?: SessionKey | null;
      reason?: string;
    },
  ): Live {
    const record: CallRecord = {
      id: genId("call"),
      provider: this.deps.provider.name,
      direction,
      conversation,
      requestedBy: opts.requestedBy ?? null,
      reason: opts.reason ?? null,
      startedAtMs: this.now(),
      answeredAtMs: null,
      endedAtMs: null,
      endReason: null,
      handedOff: [],
    };
    const live: Live = {
      record,
      providerCallId: opts.providerCallId,
      phase: direction === "incoming" ? "ringing" : "dialing",
      expectedHandle: opts.expectedHandle ?? null,
      requestId: opts.requestId ?? null,
      voice: new VoiceOut({
        speaker: this.deps.speaker,
        provider: {
          say: (chunkId, pcm, sampleRate) => {
            this.markSound(live);
            return this.deps.provider.say(chunkId, pcm, sampleRate);
          },
          flush: () => this.deps.provider.flush(),
        },
        onSaid: (text, heard) =>
          this.record(live, { speaker: "edmund", text, atMs: this.now(), heard }),
      }),
      heard: [],
      endpointTimer: null,
      timers: [],
      turnEnd: null,
      trace: newTrace(),
      hearingRestarts: 0,
    };
    // Nothing on a call should wait for something to load.
    this.deps.speaker.warm?.();
    // Speech waits for the call to connect; the greeting is synthesised while
    // it rings and sent the moment it does.
    live.voice.hold();
    this.live = live;
    this.deps.store.createCall(record, opts.providerCallId);
    bindVoice(conversation.sessionKey, this.bindingFor(live));
    return live;
  }

  private bindingFor(live: Live): VoiceBinding {
    const { voice, record } = live;
    return {
      callId: record.id,
      // After the call the voice is closed and answers for itself: a reply
      // from a connected call is texted, a greeting for a missed one dropped.
      deliver: (text, turnId) => voice.deliver(text, turnId),
      onTurnStarted: (turnId) => voice.beginTurn(turnId),
      onTextDelta: (turnId, text) => {
        if (live.trace.handoffAt !== null) live.trace.wordsAt ??= this.now();
        voice.delta(turnId, text);
      },
      onTurnSettled: (turnId, outcome) => voice.settle(turnId, outcome),
      envelopeBlock: () =>
        callEnvelopeBlock({
          provider: record.provider,
          label: record.conversation.label,
          isGroup: record.conversation.isGroup,
          direction: record.direction,
          answeredAtMs: record.answeredAtMs,
          nowMs: this.now(),
          cutOff: voice.takeCutOff(),
        }),
    };
  }

  private record(live: Live, utterance: Utterance): void {
    this.deps.store.addUtterance(live.record.id, utterance);
    void this.forEachCompanion("onUtterance", (c) => c.onUtterance?.(live.record, utterance));
  }

  private async forEachCompanion(
    hook: string,
    run: (companion: CallCompanion) => void | Promise<void>,
  ): Promise<void> {
    for (const companion of this.deps.companions) {
      try {
        await run(companion);
      } catch (err) {
        log.warn("calls", `companion ${companion.name} ${hook} failed`, {
          err: (err as Error).message,
        });
      }
    }
  }
}
