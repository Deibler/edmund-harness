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
   * transcript is in, after `turnCompleteGraceMs`. Below it they may be mid-
   * thought ("and then...", "um"), and Edmund listens for `turnIncompleteWaitMs`
   * more of quiet before taking it as the end. With no verdict, `endpointMs`
   * after the final transcript, as before.
   */
  turnThreshold: number;
  turnCompleteGraceMs: number;
  turnIncompleteWaitMs: number;
  /**
   * The wait when the detector says mid-thought but what they said reads as
   * a finished sentence (it ends in a full stop or a question mark). The
   * transcript is a second opinion on the detector, which is often wrong on
   * a real caller: of 35 pauses it scored unfinished, 29 were transcribed
   * with a sentence end, and on one call 4 of 4 finished sentences scored
   * 0.03-0.05 (91 exchanges, 2026-10-29 to 11-12). Each cost the full
   * `turnIncompleteWaitMs` of dead air.
   */
  turnPunctuatedWaitMs: number;
  /** How long "uh" by itself waits for the rest before it is handed over anyway. */
  hesitationHoldMs: number;
  /** Quiet after the caller's last sound before a held reply is said after all. */
  holdReleaseMs: number;
  /** How long an outgoing call may ring before Edmund gives up. */
  dialTimeoutMs: number;
  /**
   * What is said when a call connects and Edmund's own opening line is not
   * written yet, after `openerGraceMs` of waiting for it. Empty says nothing.
   * It is what a person says into a phone, in whatever voice he is using, and
   * commits him to nothing: his line follows it when it arrives.
   */
  openerLine: string;
  openerGraceMs: number;
  /**
   * Short sounds of thinking ("Hmm."), one of which is said when the caller
   * has finished and no word of Edmund's reply has been written this long
   * after they stopped. Empty, or zero, never says one.
   */
  thinkingSounds: string[];
  thinkingAfterMs: number;
  /**
   * Quiet on both sides for this long and Edmund is told, so he can check
   * they are still there or end the call. Each further check waits twice as
   * long; `QUIET_CHECKS` of them without a word from the caller and he is
   * not told again. Zero never checks.
   */
  quietCheckMs: number;
  /** How often the request and command queues are read. */
  pollMs: number;
};

export type CallManagerDeps = {
  settings: CallSettings;
  /** How Edmund is on a call, and the way he dials out. */
  provider: CallProvider;
  /**
   * Further ways to be on a call that only take incoming ones (the voice
   * lab). Each call is served start to finish by the provider it came in on,
   * under the same rules and the same one call at a time.
   */
  inboundProviders?: CallProvider[];
  store: CallStore;
  speaker: Speaker;
  /**
   * Load what hears the caller, if it is not loaded: called as a call starts
   * ringing either way, so it is ready (and paged in) before anyone speaks.
   */
  prepareToHear: () => void;
  conversationFor: (peer: Peer) => CallConversation | null;
  /**
   * Make the conversation one a wake-up can reach, before anything is sent to
   * it. A person never texted has no session yet, and an event fired at a
   * session that does not exist is dropped without a word (conversation.ts).
   */
  ensureConversation: (conversation: CallConversation) => void;
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
  /** Each exchange's timings (trace.ts), as they are logged. */
  onExchange?: (call: CallRecord, fields: Record<string, number | string>) => void;
  now?: () => number;
};

type Live = {
  record: CallRecord;
  /** The provider this call is on. */
  provider: CallProvider;
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
  /** Says a held reply once the caller has been quiet without taking a turn. */
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** The caller is making sound right now. */
  callerTalking: boolean;
  /** A turn has been handed over and its reply has neither begun nor been given up. */
  awaitingReply: boolean;
  thinkingTimer: ReturnType<typeof setTimeout> | null;
  /** The thinking sound said last, so the next one differs. */
  lastThinkingSound: string | null;
  /**
   * Everything in `heard` is a listening noise ("yeah", "mm-hmm") made while
   * Edmund was speaking: not a turn while he still is.
   */
  heardOnlyBackchannel: boolean;
  /** When the first of those was heard. */
  backchannelAt: number;
  /** When the latest settled words were heard. */
  heardAt: number;
  /** When anyone last spoke, started to, or was owed a reply. */
  lastActivityAt: number;
  /** Quiet checks sent since the caller last said anything. */
  quietChecks: number;
  quietTimer: ReturnType<typeof setInterval> | null;
  /** Things the next turn should know, told once (see envelope.ts). */
  notes: string[];
};

/** Two words of new speech while Edmund talks is a barge-in; a cough is not. */
const BARGE_IN_WORDS = 2;
/** Longest end_call waits for Edmund's last words to finish playing. */
const HANGUP_DRAIN_MS = 15_000;
/** A thinking sound answers a turn of at least this many words: not "okay", not "bye". */
const THINKING_MIN_WORDS = 3;
/** How often a held backchannel looks again for Edmund to have stopped speaking. */
const BACKCHANNEL_RECHECK_MS = 250;
/** ...and the longest it is held, however long he goes on (or seems to). */
const BACKCHANNEL_MAX_HOLD_MS = 15_000;
/** How much of a call's transcript the conversation that asked for it is given. */
const TRANSCRIPT_CHARS = 4_000;
/** Quiet checks in a row, unanswered by the caller, before Edmund stops being told. */
const QUIET_CHECKS = 4;

/**
 * Listening noises: what people say while someone else is talking to show
 * they are following. Said over Edmund, they are not an interruption, and
 * they are not a turn for him to answer while he is still speaking. Every
 * voice framework that handles interruptions keeps such a list; without one
 * "uh-huh" (two words) stopped Edmund mid-sentence.
 */
const BACKCHANNEL = new Set(
  "yeah yea yep yup yes ok okay right sure uh huh uhhuh mm mmm mhm mhmm mmhm mmhmm hmm hm oh ah i see got it gotcha cool nice wow true exactly totally alright".split(
    " ",
  ),
);
/** One word of these does stop him, where any other single word does not. */
const STOP_WORDS = new Set(["stop", "wait"]);
/**
 * The sound of someone about to speak: not a turn by itself. "Uh" was handed
 * over as one on 2026-11-12 and answered, five seconds later, with "Sorry,
 * did that come through garbled?"
 */
const HESITATION = new Set("uh uhh um umm er erm ah hmm hm so and but well like".split(" "));

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/-/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

/** Nothing but listening noises, and few of them. */
export function isBackchannel(text: string): boolean {
  const words = wordsOf(text);
  return words.length > 0 && words.length <= 3 && words.every((w) => BACKCHANNEL.has(w));
}

/** Nothing but the sound of being about to say something. */
export function isHesitation(text: string): boolean {
  const words = wordsOf(text);
  return words.length > 0 && words.length <= 2 && words.every((w) => HESITATION.has(w));
}

/** What they said reads as a finished sentence. */
export function endsSentence(text: string): boolean {
  return /[.?!]["')\]]*\s*$/.test(text);
}

/** Whether words said while Edmund speaks (or before he has begun) should stop him. */
export function interrupts(text: string): boolean {
  const words = wordsOf(text);
  if (words.some((w) => STOP_WORDS.has(w))) return true;
  return words.length >= BARGE_IN_WORDS && !isBackchannel(text);
}

/**
 * What Edmund is told while a call he placed is ringing. It has to say that
 * the call is already placed and that his reply is the opening line itself:
 * told "You are calling <name>; it is ringing... You are calling because:
 * <the owner> asked me to call her", he called facetime_call again and wrote
 * "I'm calling <name> now on FaceTime to check that calls come through.
 * I'll let <the owner> know how it goes", which is what she heard when she
 * picked up (2026-11-12). The reason is his own note from another conversation, so
 * it is quoted as one.
 */
export function ringingEvent(provider: string, label: string, reason: string | null): string {
  const note = reason ? ` Your note on why you are calling: "${reason}"` : "";
  return [
    `[${provider}] You have already placed a call to ${label} and it is ringing on their end. Do not call facetime_call again.${note}`,
    `Reply with only the words ${label} should hear when they pick up, said to them: hello, and why you are calling, in a sentence or two. Your reply is spoken to them and seen by no one else, so it is not the place to say what you are doing or to report to anyone.`,
  ].join("\n");
}

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

  private providers(): CallProvider[] {
    return [this.deps.provider, ...(this.deps.inboundProviders ?? [])];
  }

  async start(): Promise<void> {
    const unfinished = this.deps.store.endUnfinished(this.now(), "Edmund restarted");
    if (unfinished > 0) log.warn("calls", "ended calls left open by the last run", { unfinished });
    for (const provider of this.providers()) {
      await provider.start((event) => void this.onEvent(provider, event), {
        diedMidCall: unfinished > 0,
      });
    }
    this.poller = setInterval(() => void this.drainQueues(), this.deps.settings.pollMs);
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.live) await this.end("Edmund shut down", { hangup: true });
    for (const provider of this.providers()) await provider.stop();
  }

  /** The live call's conversation, if any. */
  current(): CallRecord | null {
    return this.live?.record ?? null;
  }

  // ── Events ────────────────────────────────────────────────────────────

  private async onEvent(from: CallProvider, event: ProviderEvent): Promise<void> {
    try {
      switch (event.type) {
        case "call":
          return await this.onCall(from, event.call);
        case "readiness":
          log.info("calls", `${from.name} ${event.ready ? "ready" : "not ready"}`, {
            detail: event.detail,
          });
          return;
        case "silence-breach":
          return await this.onSilenceBreach(event.device, event.detail);
      }
      // What a provider hears or plays belongs to its own call, never another's.
      if (this.live?.provider !== from) return;
      switch (event.type) {
        case "heard":
          return this.onHeard(event.text, event.final, event.spokeUntilMs);
        case "pause":
          return this.onPause(event.stoppedAtMs, event.probability);
        case "speech":
          return this.onSpeech(event.talking);
        case "spoken":
          return this.live?.voice.onSpoken(event.chunkId, event.played);
        case "hearing-failed":
          return await this.onHearingFailed(event.detail);
      }
    } catch (err) {
      log.error("calls", "event handling failed", {
        type: event.type,
        err: (err as Error).message,
      });
    }
  }

  private async onCall(from: CallProvider, call: ProviderCall): Promise<void> {
    const live = this.live;
    if (live && live.provider === from && call.id === live.providerCallId) {
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
      return this.ringing(from, call);
    }
  }

  // ── Incoming ──────────────────────────────────────────────────────────

  private async ringing(provider: CallProvider, call: ProviderCall): Promise<void> {
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
    // Answered deaf, a call sounds like Edmund ignoring them; left ringing, it
    // is a missed call.
    const hearing = await this.canHear(provider);
    if (!hearing.ok) {
      this.deps.alert(
        `${conversation.label} called on ${provider.name} and Edmund did not answer: he could not have heard them (${hearing.detail}).`,
      );
      return;
    }
    // Another call may have begun while that was asked.
    if (this.current()) {
      log.info("calls", "second call ignored — already on one", { peer: call.peer });
      return;
    }

    const live = this.begin(provider, conversation, "incoming", { providerCallId: call.id });
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
      `[${provider.name}] ${conversation.label} is calling and you are picking up now. What you write is the first thing they hear: greet them the way you would answering the phone.`,
    );
    const remaining = Math.max(0, deadline - this.now());
    await Promise.race([
      live.voice.firstAudioReady(),
      new Promise((r) => setTimeout(r, remaining)),
    ]);
    if (this.live !== live) return;
    try {
      await provider.answer(call.id);
    } catch (err) {
      log.error("calls", "answer failed", { err: (err as Error).message });
      return this.end("could not answer");
    }
    // Answered, and then never reported connected or ended: without this the
    // call stays "live" for good, refusing every other call and holding back
    // anything that waits for calls to finish.
    live.timers.push(
      setTimeout(() => {
        if (this.live === live && live.phase !== "active")
          void this.end("never connected", { hangup: true });
      }, this.deps.settings.dialTimeoutMs),
    );
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
    const hearing = await this.canHear(this.deps.provider);
    if (!hearing.ok) {
      this.deps.alert(
        `Edmund did not call ${conversation.label}: he could not have heard them (${hearing.detail}).`,
      );
      return this.refuse(request, `you cannot hear calls right now (${hearing.detail})`);
    }
    if (this.current()) return this.refuse(request, "already on a call");

    const live = this.begin(this.deps.provider, conversation, "outgoing", {
      providerCallId: null,
      expectedHandle: this.deps.canon(request.handle),
      requestId: request.id,
      requestedBy: request.requestedBy === conversation.sessionKey ? null : request.requestedBy,
      reason: request.reason,
    });
    try {
      const call = await live.provider.dial(request.handle);
      live.providerCallId = call.id;
      this.deps.store.finishRequest(request.id, "dialled");
      // His opening line is written while it rings, so the conversation's
      // worker moves to the call's model and the voice is synthesised before
      // anyone answers. Waiting for "picked up" left the first people he
      // called saying "hello?" into 3-7 s of silence while all that loaded.
      this.deps.fireSystemEvent(
        conversation.sessionKey,
        ringingEvent(live.provider.name, conversation.label, request.reason),
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
    live.lastActivityAt = live.record.answeredAtMs;
    this.deps.store.markAnswered(live.record.id, live.record.answeredAtMs);
    if (this.deps.settings.quietCheckMs > 0) {
      live.quietTimer = setInterval(
        () => this.checkQuiet(live),
        Math.max(20, Math.min(1_000, this.deps.settings.quietCheckMs / 4)),
      );
      live.quietTimer.unref?.();
    }
    await live.provider.listen();
    void this.whenAudible(live);
    await this.forEachCompanion("onStart", (c) => c.onStart?.(live.record));

    const maxMs = this.deps.settings.maxCallMinutes * 60_000;
    live.timers.push(
      setTimeout(
        () =>
          this.deps.fireSystemEvent(
            conversation.sessionKey,
            `[${live.provider.name}] One minute left on this call. Start wrapping up.`,
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
    const route = await live.provider
      .audioReady()
      .catch((err: unknown) => ({ ok: false as const, detail: (err as Error).message }));
    if (this.live !== live) return;
    if (!route.ok) {
      this.deps.alert(
        `${live.provider.name} call with ${live.record.conversation.label}: the caller could not have heard Edmund (${route.detail}); hung up.`,
      );
      return this.end("the caller could not hear Edmund", { hangup: true });
    }
    live.timers.push(
      setTimeout(() => {
        if (this.live !== live) return;
        live.voice.release();
        this.openIfSilent(live);
      }, this.deps.settings.connectSettleMs),
    );
  }

  /**
   * They can hear Edmund now. If his opening line is not ready, they are
   * listening to nothing: 10 s of it on 2026-11-11, and 1.5-4 s on most
   * incoming calls, which are answered at a deadline whether the greeting is
   * written or not. After a short wait for it, say what a person says into a
   * phone. His own line follows when it arrives, and he is told this was said.
   */
  private openIfSilent(live: Live): void {
    const line = this.deps.settings.openerLine;
    if (!line || live.voice.hasSpoken()) return;
    live.timers.push(
      setTimeout(() => {
        if (this.live !== live || live.voice.hasSpoken()) return;
        // They spoke first: their words get an answer, not a "hello" over them.
        if (live.callerTalking || live.heard.length > 0 || live.awaitingReply) return;
        if (!live.voice.aside(line)) return;
        live.notes.push(
          `When the call connected your opening line was not written yet, so the line said "${line}" first.`,
        );
        log.info("calls", "said the opener: the opening line was not ready", {
          call: live.record.id,
        });
      }, this.deps.settings.openerGraceMs),
    );
  }

  // ── Hearing ───────────────────────────────────────────────────────────

  private onHeard(text: string, final: boolean, spokeUntilMs?: number): void {
    const live = this.live;
    if (!live || live.phase !== "active") return;
    if (!final) {
      if (interrupts(text)) {
        // Talking over Edmund stops him; talking again before he has said a
        // word means his reply to the earlier part goes unsaid, and the next
        // one answers all of it. "Uh-huh" over him is neither.
        if (live.voice.speaking()) void live.voice.bargeIn();
        else if (live.voice.awaitingFirstWords()) live.voice.supersede();
      }
      if (live.voice.holding()) this.armHold(live);
      return;
    }
    // A final with no words (".", noise) is not something they said: it
    // started a turn on 2026-10-29 that Edmund answered with an apology.
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    live.lastActivityAt = this.now();
    live.heardAt = live.lastActivityAt;
    live.quietChecks = 0;
    // Settled words mean that stretch of speech is over. The ear says when
    // someone starts talking and never that they stopped: the pause and
    // these words are how it says so.
    live.callerTalking = false;
    // A listening noise while Edmund is speaking is kept, not answered: it
    // joins whatever they say next, or becomes their turn once he has stopped.
    const noise = isBackchannel(text) && live.voice.speaking();
    const onlyNoise = noise && (live.heard.length === 0 || live.heardOnlyBackchannel);
    if (onlyNoise && !live.heardOnlyBackchannel) live.backchannelAt = this.now();
    live.heardOnlyBackchannel = onlyNoise;
    live.heard.push(text.trim());
    live.trace.finalAt = this.now();
    if (spokeUntilMs !== undefined) live.trace.stoppedAt ??= spokeUntilMs;
    if (live.turnEnd === "complete") this.armEndpoint(live, this.deps.settings.turnCompleteGraceMs);
    else if (live.turnEnd === null) this.armEndpoint(live, this.deps.settings.endpointMs);
    // Incomplete by the detector, a finished sentence by the transcript: the
    // short wait. Otherwise the wait armed at the pause stands.
    else if (endsSentence(text)) this.armIncomplete(live, this.deps.settings.turnPunctuatedWaitMs);
  }

  /** The caller paused; the turn detector has judged whether they are done. */
  private onPause(stoppedAtMs: number, probability: number | null): void {
    const live = this.live;
    if (!live) return;
    // With or without a verdict, they have stopped: see onHeard.
    live.callerTalking = false;
    live.lastActivityAt = this.now();
    if (live.phase !== "active" || probability === null) return;
    live.trace.stoppedAt = stoppedAtMs;
    live.trace.pausedAt = this.now();
    live.trace.probability = probability;
    if (probability >= this.deps.settings.turnThreshold) {
      live.turnEnd = "complete";
      if (live.heard.length > 0) this.armEndpoint(live, this.deps.settings.turnCompleteGraceMs);
    } else {
      // Mid-thought, by the detector. It was wrong about half of a live
      // call's finished sentences (13/21 right overall on 2026-10-29), so the
      // wait is short: if they were not done, the reply Edmund starts is held
      // and folded into his answer to the rest.
      live.turnEnd = "incomplete";
      this.armIncomplete(live, this.deps.settings.turnIncompleteWaitMs);
    }
  }

  /** After `ms` more of quiet, a pause the detector called unfinished is the end of their turn. */
  private armIncomplete(live: Live, ms: number): void {
    if (live.endpointTimer) clearTimeout(live.endpointTimer);
    live.endpointTimer = setTimeout(() => {
      live.endpointTimer = null;
      if (this.live !== live || live.turnEnd !== "incomplete") return;
      live.turnEnd = "complete";
      if (live.heard.length > 0) this.flushHeard(live);
    }, ms);
  }

  private onSpeech(talking: boolean): void {
    const live = this.live;
    if (!live) return;
    live.callerTalking = talking;
    live.lastActivityAt = this.now();
    if (talking) {
      // A new utterance after Edmund's turn began starts a new exchange.
      if (live.trace.handoffAt !== null) live.trace = newTrace();
      if (live.voice.holding()) this.armHold(live);
      live.turnEnd = null;
      if (live.endpointTimer) clearTimeout(live.endpointTimer);
      live.endpointTimer = null;
    } else if (live.turnEnd === null) {
      this.armEndpoint(live, this.deps.settings.endpointMs);
    }
  }

  /**
   * A held reply is said once the caller has been quiet for a moment without
   * forming a turn of their own. While they are mid-turn it keeps waiting:
   * their turn will either come (and the reply is dropped) or not.
   */
  private armHold(live: Live): void {
    if (live.holdTimer) clearTimeout(live.holdTimer);
    live.holdTimer = setTimeout(() => {
      live.holdTimer = null;
      if (this.live !== live || !live.voice.holding()) return;
      if (live.heard.length > 0 || live.turnEnd !== null) return this.armHold(live);
      live.voice.releaseHeld();
    }, this.deps.settings.holdReleaseMs);
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
    if (fields) {
      log.info("calls", "exchange", { call: live.record.id, ...fields });
      this.deps.onExchange?.(live.record, fields);
    }
    live.trace = newTrace();
  }

  /**
   * The caller finished a turn: hand it to the conversation as a message.
   * `atEnd` is the call ending, when whatever was heard goes over regardless.
   */
  private flushHeard(live: Live, atEnd = false): void {
    live.endpointTimer = null;
    // Only "yeah" while Edmund is still talking: look again when he may have
    // stopped. If he asked something and that was their answer, it is handed
    // over a moment after he finishes; if it was a listening noise, by then
    // they have usually said the rest.
    if (
      !atEnd &&
      live.heardOnlyBackchannel &&
      live.voice.speaking() &&
      this.now() - live.backchannelAt < BACKCHANNEL_MAX_HOLD_MS
    ) {
      live.endpointTimer = setTimeout(() => this.flushHeard(live), BACKCHANNEL_RECHECK_MS);
      return;
    }
    live.heardOnlyBackchannel = false;
    const text = live.heard.join(" ").trim();
    // "Uh" is someone about to speak: give them the time to. If nothing
    // follows it is handed over after all, so Edmund can ask.
    const held = this.now() - live.heardAt;
    const holdMs = this.deps.settings.hesitationHoldMs;
    if (!atEnd && isHesitation(text) && held < holdMs) {
      live.endpointTimer = setTimeout(() => this.flushHeard(live), holdMs - held);
      return;
    }
    live.turnEnd = null;
    live.heard = [];
    if (!text) return;
    if (live.holdTimer) clearTimeout(live.holdTimer);
    live.holdTimer = null;
    live.voice.dropHeld();
    live.trace.handoffAt = this.now();
    live.trace.wordsAt = null;
    live.trace.soundAt = null;
    live.trace.asideAt = null;
    live.lastActivityAt = live.trace.handoffAt;
    if (!atEnd) {
      live.awaitingReply = true;
      this.armThinking(live, text);
    }
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
   * While a reply is slow to come, say a short sound of thinking. People
   * leave about 200 ms between turns and read more than a second of nothing
   * on a phone as a dead line ("Hey, are you there?", 2026-11-06); Edmund's
   * first word took a median 2.1 s to be written after the turn was handed
   * over, on a warm worker. This does not make him faster. It tells them he
   * heard, the way "hmm" does.
   */
  private armThinking(live: Live, said: string): void {
    if (live.thinkingTimer) clearTimeout(live.thinkingTimer);
    live.thinkingTimer = null;
    const { thinkingSounds, thinkingAfterMs } = this.deps.settings;
    if (thinkingAfterMs <= 0 || thinkingSounds.length === 0) return;
    if (wordsOf(said).length < THINKING_MIN_WORDS) return;
    const stopped = live.trace.stoppedAt ?? live.trace.handoffAt ?? this.now();
    // Never in the same breath as the handoff, however late that came.
    const wait = Math.max(250, stopped + thinkingAfterMs - this.now());
    live.thinkingTimer = setTimeout(() => {
      live.thinkingTimer = null;
      if (this.live !== live || live.phase !== "active") return;
      // His words are on their way, they are talking again, or there is
      // nothing coming: all three want silence.
      if (!live.awaitingReply || live.trace.wordsAt !== null) return;
      if (live.callerTalking || live.heard.length > 0) return;
      const choices = thinkingSounds.filter((sound) => sound !== live.lastThinkingSound);
      const sound = choices[Math.floor(Math.random() * choices.length)] ?? thinkingSounds[0]!;
      if (live.voice.aside(sound)) live.lastThinkingSound = sound;
    }, wait);
  }

  /** A reply began, or will not: nothing is owed and no sound of thinking is due. */
  private replySettled(live: Live): void {
    live.awaitingReply = false;
    if (live.thinkingTimer) clearTimeout(live.thinkingTimer);
    live.thinkingTimer = null;
    live.lastActivityAt = this.now();
  }

  /**
   * Nobody has said anything for a while. Edmund is told and decides: check
   * they are there, say the agent is still working, or end the call. Before
   * this a call that went quiet stayed up in silence until someone hung up
   * (a minute into a voicemail greeting on 2026-10-29).
   */
  private checkQuiet(live: Live): void {
    if (this.live !== live || live.phase !== "active") return;
    if (live.quietChecks >= QUIET_CHECKS) return;
    if (live.callerTalking || live.awaitingReply || live.heard.length > 0) return;
    if (live.voice.speaking() || live.voice.holding()) return;
    const quietMs = this.now() - live.lastActivityAt;
    if (quietMs < this.deps.settings.quietCheckMs * 2 ** live.quietChecks) return;
    live.quietChecks += 1;
    live.lastActivityAt = this.now();
    const last = live.quietChecks >= QUIET_CHECKS;
    this.deps.fireSystemEvent(
      live.record.conversation.sessionKey,
      [
        `[${live.provider.name}] It has been quiet for ${Math.round(quietMs / 1000)} seconds: neither of you has said anything.`,
        "If they are waiting on you, tell them where things stand. If you are waiting on them, check they are still there in a few words.",
        "If the call seems over, or you reached a voicemail greeting, say a short goodbye and end_call.",
        last
          ? "You will not be told about the quiet again on this call."
          : "If nothing needs saying, KEEP_QUIET.",
      ].join(" "),
    );
  }

  /**
   * The call's audio stopped reaching the ear. Nothing on that path keeps
   * state that a restart would clear (the recogniser that once did, and died
   * mid-call, is gone), so trying again would fail the same way while the
   * caller talks to nobody. The call ends and the operator hears why.
   */
  private async onHearingFailed(detail: string): Promise<void> {
    const live = this.live;
    if (!live || live.phase !== "active") return;
    this.deps.alert(
      `${live.provider.name} call with ${live.record.conversation.label}: Edmund stopped hearing them (${detail}); hung up.`,
    );
    return this.end("Edmund could not hear them", { hangup: true });
  }

  /** A provider that cannot answer the question cannot hear either. */
  private async canHear(
    provider: CallProvider,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    return provider
      .canHear()
      .catch((err: unknown) => ({ ok: false as const, detail: (err as Error).message }));
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
    if (live.holdTimer) clearTimeout(live.holdTimer);
    if (live.thinkingTimer) clearTimeout(live.thinkingTimer);
    if (live.quietTimer) clearInterval(live.quietTimer);
    const answered = live.record.answeredAtMs !== null;
    // Anything the caller said just before it ended still reaches the
    // conversation; with the voice gone, the reply to it is texted.
    if (live.endpointTimer) clearTimeout(live.endpointTimer);
    try {
      this.flushHeard(live, true);
    } catch (err) {
      // Whatever goes wrong handing over their last words, the call still ends.
      log.error("calls", "could not hand over what was heard last", {
        err: (err as Error).message,
      });
    }
    // A reply caught mid-way on a call that connected goes out as a text. A
    // greeting for a call that never connected is dropped: it was for a
    // conversation that did not happen.
    live.voice.close(answered ? "text" : "drop");
    // Speech already handed to the provider would otherwise keep playing into
    // a line nobody is on.
    await live.provider.flush().catch(() => {});
    const conversation = live.record.conversation;
    unbindVoice(conversation.sessionKey, live.record.id);

    if (opts.hangup && live.providerCallId) {
      await live.provider.hangup(live.providerCallId).catch((err: unknown) => {
        log.warn("calls", "hangup failed", { err: (err as Error).message });
      });
    }
    await live.provider.stopListening().catch(() => {});
    live.record.endedAtMs = this.now();
    live.record.endReason = reason;
    this.deps.store.markEnded(live.record.id, live.record.endedAtMs, reason);
    log.info("calls", `call with ${conversation.label} ended`, { reason, call: live.record.id });

    const name = live.provider.name;
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
    if (live.record.requestedBy) {
      lines.push(
        `The conversation that asked for this call has been given what was said. Do not report to it from here: anything you send here goes to ${conversation.label}.`,
      );
    }
    lines.push(
      "If anything from the call needs a follow-up text, send it now; otherwise KEEP_QUIET.",
    );
    this.deps.fireSystemEvent(conversation.sessionKey, lines.join("\n"));
    if (live.record.requestedBy) {
      // With what was said: told only that it ended, the conversation that
      // asked went through the daemon log and calls.db to find out how it
      // went before it could say (2026-11-12).
      this.deps.fireSystemEvent(
        live.record.requestedBy,
        [
          `[${name}] The call you asked for with ${conversation.label} ended after ${took} (${reason}).`,
          this.transcriptFor(live),
        ].join("\n"),
      );
    }
  }

  /** Both sides of the call as lines, the most recent kept if it ran long. */
  private transcriptFor(live: Live): string {
    const label = live.record.conversation.label;
    const lines = this.deps.store
      .utterances(live.record.id)
      .map(
        (u) =>
          `${u.speaker === "edmund" ? "You" : label}: ${u.text}${u.heard ? "" : " (they did not hear this)"}`,
      );
    if (lines.length === 0) return "Nothing was said on it.";
    const kept: string[] = [];
    let size = 0;
    for (const line of lines.reverse()) {
      size += line.length + 1;
      if (size > TRANSCRIPT_CHARS) break;
      kept.unshift(line);
    }
    const cut = kept.length < lines.length ? "(earlier part left out)\n" : "";
    return `What was said:\n${cut}${kept.join("\n")}`;
  }

  // ── Plumbing ──────────────────────────────────────────────────────────

  private targetFor(conversation: CallConversation): CallTarget {
    return conversation.isGroup
      ? { kind: "group", chatGuid: conversation.chatGuid }
      : { kind: "person", handle: conversation.handles[0]! };
  }

  private begin(
    provider: CallProvider,
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
      provider: provider.name,
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
      provider,
      providerCallId: opts.providerCallId,
      phase: direction === "incoming" ? "ringing" : "dialing",
      expectedHandle: opts.expectedHandle ?? null,
      requestId: opts.requestId ?? null,
      voice: new VoiceOut({
        speaker: this.deps.speaker,
        provider: {
          say: (chunkId, pcm, sampleRate) => provider.say(chunkId, pcm, sampleRate),
          flush: () => provider.flush(),
        },
        onSpeaking: (kind) => {
          live.lastActivityAt = this.now();
          if (kind === "aside") {
            if (live.trace.handoffAt !== null) live.trace.asideAt ??= this.now();
            return;
          }
          this.replySettled(live);
          this.markSound(live);
        },
        onSaid: (text, heard) => {
          live.lastActivityAt = this.now();
          this.record(live, { speaker: "edmund", text, atMs: this.now(), heard });
        },
      }),
      heard: [],
      endpointTimer: null,
      timers: [],
      turnEnd: null,
      trace: newTrace(),
      holdTimer: null,
      callerTalking: false,
      awaitingReply: false,
      thinkingTimer: null,
      lastThinkingSound: null,
      heardOnlyBackchannel: false,
      backchannelAt: 0,
      heardAt: 0,
      lastActivityAt: this.now(),
      quietChecks: 0,
      quietTimer: null,
      notes: [],
    };
    // Before the first event is fired at it: see ensureConversation.
    this.deps.ensureConversation(conversation);
    // Nothing on a call should wait for something to load.
    this.deps.speaker.warm?.();
    this.deps.prepareToHear();
    // Speech waits for the call to connect; the greeting is synthesised while
    // it rings and sent the moment it does.
    live.voice.hold();
    // Kept ready from the first ring, so it costs nothing when it is wanted.
    if (this.deps.settings.openerLine) live.voice.prepare(this.deps.settings.openerLine);
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
      onTurnSettled: (turnId, outcome) => {
        voice.settle(turnId, outcome);
        // Whatever it said has been queued by now; if it said nothing, nothing is coming.
        this.replySettled(live);
      },
      envelopeBlock: () =>
        callEnvelopeBlock({
          provider: record.provider,
          label: record.conversation.label,
          isGroup: record.conversation.isGroup,
          direction: record.direction,
          answeredAtMs: record.answeredAtMs,
          nowMs: this.now(),
          cutOff: voice.takeCutOff(),
          notes: live.notes.splice(0),
          askedElsewhere: record.requestedBy !== null,
          thinkingSounds:
            this.deps.settings.thinkingAfterMs > 0 && this.deps.settings.thinkingSounds.length > 0,
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
