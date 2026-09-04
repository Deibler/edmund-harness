import type { SessionPipeline } from "../../../src/channels/pipeline.ts";
import type { Config } from "../../../src/config/config.ts";
import type { InboundMessage } from "../../../src/imessage/types.ts";
import type { SessionKey } from "../../../src/sessions/key.ts";
import { genId } from "../../../src/util/ids.ts";
import { mirrorConfig } from "../config.ts";
import type { MirrorBackgroundJob } from "./background-watch.ts";
import type { MirrorBridge, MirrorDelivery } from "./bridge.ts";
import type { MirrorConversationMessage } from "./protocol.ts";
import type { MirrorStore } from "./store.ts";
import {
  addressesEdmund,
  conversationIntent,
  echoWords,
  mentionsInvocation,
  stripInvocation,
} from "./utterance.ts";
import { speakable, speechChunks, synthesizeSpeech, transcribeUtterance } from "./voice.ts";

type ModelPhase = "thinking" | "working" | "responding";
type TurnOutcome = "tool-only" | "silent" | "error" | "interrupted" | "delivered";

/**
 * Adapts wake/voice and screen delivery to Edmund's shared session pipeline.
 * The Pi owns physical capture/playback; this class owns the conversational
 * generation, interruption policy, and event-driven screen projection.
 */
export class MirrorOrchestrator {
  private readonly config: Config;
  private readonly pipeline: SessionPipeline;
  private readonly bridge: MirrorBridge;
  private readonly store: MirrorStore;
  private readonly sessionKey: SessionKey;
  private readonly interruptModel: (reason: string) => boolean;
  private syntheticSequence = 0;
  private conversationUntil = 0;
  private messages: MirrorConversationMessage[] = [];
  private activeTurnId: string | null = null;
  /** The model's own last reported activity, unclobbered by speech phases. */
  private modelPhase: ModelPhase | null = null;
  /** Plain-language note on the current tool, shown while "working". */
  private modelDetail: string | undefined;
  private ignoredTurns = new Set<string>();
  private deliveryEnabled = false;
  private wakeInProgress = false;
  /**
   * Confidence reported by the Pi's wake detector, or undefined when the
   * detector cannot produce one. Read once per wake by the gate below.
   */
  private wakeScore: number | undefined;
  /**
   * Above this, the detector's own confidence settles it and the transcript
   * is not re-read. openWakeWord's scores are calibrated, so this is a real
   * probability rather than an arbitrary cut — tune it against a
   * false-accepts/hour target with deploy/wake-bench.py, not by feel.
   */
  private static readonly TRUSTED_WAKE_SCORE = 0.5;
  private currentPhase: ModelPhase = "thinking";
  private speechGeneration = 0;
  /** speak() calls past their gates but not yet owned by pendingAudio. */
  private speechInFlight = 0;
  private pendingAudio = new Map<string, { messageId: string; text: string; generation: number }>();
  private projectionPhase: "idle" | "listening" | "thinking" | "working" | "responding" = "idle";
  private projectionDirty = false;
  private projectionInFlight = false;
  /**
   * Sub-agents this session spawned that have not settled.
   *
   * They are spawned from inside an MCP subprocess rather than the daemon, so
   * nothing here observes them being created — `onBackgroundWork` reconciles
   * this set from the agents table on a timer.
   */
  private backgroundJobs = new Set<string>();
  /** Jobs that were live when the user explicitly dismissed the dock. They
   *  stop holding the glass open, but are still tracked so a LATER job is not
   *  pre-dismissed by an id it happens to reuse. */
  private dismissedJobs = new Set<string>();
  /** When the current run of background work began. 0 when there is none. */
  private backgroundSince = 0;
  /** True while the dock is being held open purely by background work. */
  private holdingForBackground = false;
  /** Whether the roster widget is currently on the glass, so it is removed
   *  once and not on every idle tick. */
  private rosterShown = false;
  private readonly voice: {
    transcribe: typeof transcribeUtterance;
    synthesize: typeof synthesizeSpeech;
  };

  private static readonly CONVERSATION_WINDOW_MS = 10 * 60_000;
  private static readonly SPEECH_EXTEND_MS = 5 * 60_000;
  /**
   * How far ahead background work keeps the volley attached.
   *
   * Re-applied on every reconcile tick while a job runs, so the real hold is
   * "until the job settles, plus this". The tail is what matters: the result
   * arrives as a wake-up turn a couple of seconds after the last agent exits,
   * and it must land inside an OPEN volley or it is silently painted on the
   * glass instead of spoken — which is exactly the failure this fixes.
   */
  private static readonly BACKGROUND_HOLD_MS = 90_000;
  /** Ceiling on holding the dock for one run of background work. A wedged
   *  agent must not own the glass indefinitely; the store's own zombie reaper
   *  works on a similar horizon. */
  private static readonly BACKGROUND_MAX_MS = 30 * 60_000;
  private static readonly ROSTER_ID = "system:agents";
  /** Short on purpose: the roster is re-upserted on every reconcile tick, so
   *  this only ever fires when the thing writing it has stopped. A status
   *  display that outlives what it reports is worse than none. */
  private static readonly ROSTER_TTL_MS = 20_000;
  /** How long spoken text stays comparable for echo rejection. */
  private static readonly ECHO_MEMORY_MS = 20_000;
  /** Fraction of an utterance's words that must be ours before we call it echo. */
  private static readonly ECHO_OVERLAP = 0.6;
  /** Below this many words, overlap is meaningless — "yes" is not an echo. */
  private static readonly ECHO_MIN_WORDS = 4;
  private recentSpeech: Array<{ words: Set<string>; at: number }> = [];

  constructor(opts: {
    config: Config;
    pipeline: SessionPipeline;
    bridge: MirrorBridge;
    store: MirrorStore;
    interruptModel?: (reason: string) => boolean;
    voice?: {
      transcribe?: typeof transcribeUtterance;
      synthesize?: typeof synthesizeSpeech;
    };
  }) {
    this.config = opts.config;
    this.pipeline = opts.pipeline;
    this.bridge = opts.bridge;
    this.store = opts.store;
    this.sessionKey = mirrorConfig(opts.config).session_key as SessionKey;
    this.interruptModel = opts.interruptModel ?? (() => false);
    this.voice = {
      transcribe: opts.voice?.transcribe ?? transcribeUtterance,
      synthesize: opts.voice?.synthesize ?? synthesizeSpeech,
    };
  }

  onWake(detection?: { score?: number; label?: string }): void {
    // A score means a real wake model decided this, and how sure it was. Its
    // absence means the Vosk grammar fallback fired, which cannot produce one
    // — so that is the case, and the only case, that still needs the
    // transcript re-read downstream.
    this.wakeScore = detection?.score;
    console.log(
      `[mirror] wake${
        detection?.score === undefined
          ? " (unscored detector)"
          : ` ${detection.label ?? "?"} score=${detection.score.toFixed(3)}`
      }`,
    );
    const continuing = this.conversationOpen() || this.activeTurnId !== null;
    if (!continuing) this.messages = [];
    this.wakeInProgress = true;
    this.deliveryEnabled = false;
    this.speechGeneration += 1;
    // The Pi has already projected listening and the browser has stopped
    // active audio. Intent is not known until authoritative STT completes.
  }

  onListenTimeout(): void {
    this.wakeInProgress = false;
    if (this.activeTurnId && this.conversationOpen() && !this.isIgnored(this.activeTurnId)) {
      this.deliveryEnabled = true;
      this.queueProjection(this.currentPhase);
      return;
    }
    // A delegated job outlives the volley that started it. Folding on the
    // follow-up timeout is what used to erase a running job from the glass
    // the moment he stopped talking.
    if (this.backgroundActive()) {
      this.holdForBackground();
      return;
    }
    this.endConversation();
    this.queueProjection("idle");
  }

  /**
   * Reconcile the sub-agents this session is still waiting on.
   *
   * Called on a timer with the authoritative id list from the agents table, so
   * it must be idempotent — the same ids arriving again change nothing. It is
   * also the only thing that folds a dock left open by background work, so the
   * fold condition is re-tested every tick rather than fired once on an edge.
   */
  onBackgroundWork(jobs: readonly MirrorBackgroundJob[]): void {
    this.syncAgentRoster(jobs);
    const live = new Set(jobs.map((job) => job.id));
    // A dismissal only ever covered the jobs that existed at the time. Once
    // one settles, drop it so the set cannot grow without bound.
    for (const id of [...this.dismissedJobs]) {
      if (!live.has(id)) this.dismissedJobs.delete(id);
    }
    this.backgroundJobs = live;
    if (this.waitingJobCount() === 0) this.backgroundSince = 0;
    else if (this.backgroundSince === 0) this.backgroundSince = Date.now();

    // Anything with a real claim on the dock takes precedence: a live turn is
    // already projecting its own phase, and speech in flight owns the floor.
    const free = this.activeTurnId === null && this.speechSettled() && !this.wakeInProgress;
    if (this.backgroundActive()) {
      if (free) this.holdForBackground();
      return;
    }
    this.holdingForBackground = false;
    // No work, nothing talking, and the volley has lapsed — fold. Checked on
    // every tick because the hold has no other timer behind it: without this
    // the dock would sit open forever after a job that produced no wake-up.
    if (free && this.projectionPhase !== "idle" && Date.now() >= this.conversationUntil) {
      this.endConversation();
      this.queueProjection("idle");
    }
  }

  onAudioDone(error: boolean, requestId: string, detail?: string): void {
    const pending = this.pendingAudio.get(requestId);
    if (!pending) return;
    this.pendingAudio.delete(requestId);
    if (pending.generation !== this.speechGeneration || this.wakeInProgress) return;

    this.finishAssistantMessage(pending.messageId, pending.text);
    if (error) {
      console.warn(
        `[mirror] audio ended with error: ${(detail ?? "playback error").slice(0, 120)}`,
      );
    }
    // A turn still in flight means this was INTERIM speech — the model said
    // something like "give me a second" through speak_on_mirror and is still
    // working. Settling here would hand the floor back and show "Listening"
    // while the real answer is still being produced, which reads as the mirror
    // having given up. Go back to what the model is actually doing instead;
    // the turn's own completion is what ends the volley.
    if (this.activeTurnId !== null) {
      const phase = this.modelPhase ?? "working";
      this.currentPhase = phase;
      this.queueProjection(phase);
      return;
    }
    this.queueProjection("responding");
    if (this.speechSettled()) void this.settleAfterResponse();
  }

  onScreenStatus(connected: boolean): void {
    if (connected) return;
    this.pendingAudio.clear();
    this.endConversation();
    this.queueProjection("idle");
  }

  onTurnStarted(turnId: string): void {
    this.activeTurnId = turnId;
    this.currentPhase = "thinking";
    this.modelPhase = "thinking";
    this.modelDetail = undefined;
    if (this.conversationOpen() && !this.wakeInProgress) {
      this.deliveryEnabled = true;
    }
  }

  onModelPhase(turnId: string, phase: ModelPhase, detail?: string): void {
    if (!this.acceptsTurn(turnId)) return;
    this.currentPhase = phase;
    // Remembered separately from currentPhase, which speaking overwrites with
    // "responding". When interim speech finishes mid-turn we need to go back to
    // what the MODEL is actually doing, not to what the speaker was doing.
    this.modelPhase = phase;
    // Only "working" carries a detail. Thinking and responding are already
    // self-explanatory on the glass, and a stale tool label under them would
    // describe something the model has already moved on from.
    this.modelDetail = phase === "working" ? detail : undefined;
    this.queueProjection(phase);
  }

  onModelTextDelta(turnId: string, delta: string): void {
    if (!delta || !this.acceptsTurn(turnId)) return;
    // The browser reveals the final response from actual audio.currentTime.
    // Model deltas still authoritatively mark the phase, but projecting their
    // text here would put captions ahead of Edmund's voice.
    this.currentPhase = "responding";
    this.queueProjection("responding");
  }

  closeConversation(reason = "model requested Close()"): void {
    console.log(`[mirror] conversation closed (${reason.slice(0, 120)})`);
    this.ignoreActiveTurn();
    this.dismissBackgroundWork();
    this.endConversation();
    this.queueProjection("idle");
  }

  async onTurnSettled(turnId: string, outcome: TurnOutcome): Promise<void> {
    if (this.activeTurnId === turnId) {
      this.activeTurnId = null;
      this.modelPhase = null;
      this.modelDetail = undefined;
    }
    const ignored = this.ignoredTurns.delete(turnId);
    if (ignored || !this.deliveryEnabled || !this.conversationOpen()) return;
    if (outcome === "interrupted") return;
    if (outcome === "error") {
      this.endConversation();
      this.queueProjection("idle");
      return;
    }
    if (this.speechSettled()) await this.settleAfterResponse();
  }

  async onUtterance(wavBase64: string, eventId: string): Promise<void> {
    // Whether Edmund still had audio outstanding when this arrived decides how
    // much proof we demand that a person really spoke — see requiresInvocation
    // below. Captured before transcription, which takes long enough for the
    // reply to finish on its own.
    const heardWhileSpeaking = this.pendingAudio.size > 0;
    let transcript: string;
    try {
      transcript = await this.voice.transcribe(wavBase64, this.config);
    } catch (err) {
      console.error(`[mirror] transcription failed: ${safeError(err)}`);
      this.wakeInProgress = false;
      this.deliveryEnabled = true;
      this.conversationUntil = Date.now() + MirrorOrchestrator.CONVERSATION_WINDOW_MS;
      await this.speak("I couldn't transcribe that. Please try again.", "reply");
      return;
    }
    const spoken = transcript;

    // COMPENSATING CONTROL, and it now applies only to the unscored fallback.
    //
    // The Pi's fallback detector is a 40MB Vosk model running a grammar whose
    // entire vocabulary is the wake words plus "[unk]", so ambient speech has
    // almost nothing to decode onto and lands on "edmund" — kitchen
    // conversation and the Alexa in the same room were reliably opening turns.
    // It reports no confidence, because a constrained decoder never produces
    // one, so the only thing left to judge is the transcript.
    //
    // When a trained wake model is installed the Pi sends a calibrated score
    // instead and this branch is skipped entirely. Delete addressesEdmund and
    // this block once the fallback is gone — the whole heuristic exists to
    // stand in for a number that now arrives on the wire.
    //
    // This is the second stage of a two-stage detector: the cheap gate decides
    // whether to LISTEN, an actual transcription model decides whether it was
    // spoken to. The capture carries 2.5s of pre-roll (ten 250ms chunks), so
    // the wake word is always inside the audio being judged here.
    //
    // Follow-up captures are not wake-path and are deliberately untouched:
    // inside an open volley you never repeat a name.
    // A scored detector settles this itself: it already decided, with a
    // calibrated number, that the wake word was spoken. Re-reading the
    // transcript on top of that would only add a second, worse opinion — the
    // string matcher cannot tell "Edmund" from "admit" any better than the
    // acoustic model can, and it rejects real wakes whenever Whisper spells
    // the name a way nobody thought to list.
    const trusted =
      this.wakeScore !== undefined && this.wakeScore >= MirrorOrchestrator.TRUSTED_WAKE_SCORE;
    if (this.wakeInProgress && !trusted && !addressesEdmund(spoken)) {
      console.log(`[mirror] false wake, not addressed (${eventId}): ${spoken.slice(0, 120)}`);
      void this.bridge.resumeAudio();
      // Same disposition as a wake that captured nothing at all, which is
      // exactly what this turned out to be.
      this.onListenTimeout();
      return;
    }

    transcript = stripInvocation(transcript);
    if (!transcript) {
      this.wakeInProgress = false;
      this.endConversation();
      this.queueProjection("idle");
      return;
    }

    const intent = conversationIntent(transcript);
    if (intent === "bye") {
      console.log(`[mirror] conversation detached by voice (${eventId})`);
      this.ignoreActiveTurn();
      this.dismissBackgroundWork();
      this.endConversation();
      this.queueProjection("idle");
      return;
    }
    if (intent === "stop") {
      console.log(`[mirror] active work stopped by voice (${eventId})`);
      this.ignoreActiveTurn();
      this.pipeline.cancelQueued(this.sessionKey);
      this.interruptModel("mirror user said stop");
      this.dismissBackgroundWork();
      this.endConversation();
      this.queueProjection("idle");
      return;
    }

    // Last line of defence against the mirror hearing itself. The Pi's level
    // gate rejects Edmund's bleed acoustically; this catches whatever slips
    // through, using something no echo canceller has — we know exactly what we
    // just said. Deliberately AFTER the intent checks so "stop" always lands
    // even if it happens to echo a word he used.
    // Cutting Edmund off mid-sentence takes his name. Everything else that
    // reaches the mic while he is speaking is his own voice coming back through
    // the room, and the Pi's level gate cannot reliably tell the two apart —
    // it is still calibrating on his bleed during the first second of playback,
    // which is exactly when the mic first hears him. Full transcription can:
    // "Edmund, stop" contains the name, his own reply almost never does. This
    // is a deterministic rule, not an acoustic threshold, so it does not drift
    // with speaker volume, mic distance, or room.
    if (heardWhileSpeaking && !mentionsInvocation(spoken)) {
      console.log(
        `[mirror] not an interruption, no invocation (${eventId}): ${spoken.slice(0, 120)}`,
      );
      void this.bridge.resumeAudio();
      // The Pi set the overlay to "thinking" when it uploaded this capture, and
      // that phase carries no watchdog — returning without correcting it leaves
      // a spinner on the glass forever.
      this.restoreProjectionAfterNonTurn();
      return;
    }

    if (this.isSelfEcho(transcript)) {
      console.log(`[mirror] ignored self-echo (${eventId}): ${transcript.slice(0, 120)}`);
      // Nothing was really said, so the volley is untouched: keep speaking and
      // reopen the follow-up window rather than starting a turn.
      void this.bridge.resumeAudio();
      this.restoreProjectionAfterNonTurn();
      return;
    }

    console.log(`[mirror] heard (${eventId}): ${transcript.slice(0, 240)}`);
    // A real interruption, so the ducked audio should go rather than come back.
    if (this.pendingAudio.size > 0) {
      this.pendingAudio.clear();
      this.speechGeneration += 1;
      void this.bridge.stopAudio("user interjected");
    }
    const priorTurn = this.activeTurnId;
    if (priorTurn) {
      this.ignoredTurns.add(priorTurn);
      this.interruptModel("superseded by mirror interjection");
    }
    this.wakeInProgress = false;
    this.deliveryEnabled = true;
    this.conversationUntil = Date.now() + MirrorOrchestrator.CONVERSATION_WINDOW_MS;
    this.appendMessage({
      id: userMessageId(eventId),
      role: "user",
      text: transcript,
      final: true,
    });
    this.currentPhase = "thinking";
    this.queueProjection("thinking");
    this.pipeline.enqueue(this.sessionKey, this.inboundFor(transcript, eventId));
  }

  /**
   * Deliver a normal final response. A detached/superseded voice turn is
   * deliberately silent; automation without a voice turn still renders.
   */
  async deliver(reply: string, turnId?: string): Promise<MirrorDelivery> {
    const clean = speakable(reply);
    if (!clean || clean === "[SILENT]") return { delivered: false, suppressed: true };
    if (turnId && !this.acceptsTurn(turnId)) {
      return { delivered: false, suppressed: true };
    }
    if (this.conversationOpen() && this.deliveryEnabled) {
      const messageId = turnId ? assistantMessageId(turnId) : genId("assistant");
      this.prepareAssistantMessage(messageId);
      return this.speakInChunks(clean, messageId, turnId);
    }
    if (turnId) return { delivered: false, suppressed: true };
    return this.renderPassiveReply(clean);
  }

  /**
   * Speak a reply as a sequence of sentences rather than one block.
   *
   * What a conversation feels like is time-to-FIRST-audio, and that is bounded
   * by the first sentence instead of the whole reply — a long answer starts
   * talking in a few hundred milliseconds rather than a few seconds. Later
   * chunks synthesize while earlier ones are still playing, and the screen
   * queues them back-to-back.
   *
   * The whole reply stays on ONE caption message: chunking is a delivery
   * detail, and the glass should show an answer, not a transcript of requests.
   */
  private async speakInChunks(
    clean: string,
    messageId: string,
    turnId?: string,
  ): Promise<MirrorDelivery> {
    const chunks = speechChunks(clean);
    if (chunks.length <= 1) {
      return this.speak(clean, "reply", genId("mirror_audio"), messageId, turnId);
    }

    const generation = this.speechGeneration;
    let anyDelivered = false;
    let lastError: string | undefined;
    for (const [index, chunk] of chunks.entries()) {
      // Bail the moment the volley moves on — a superseded or interrupted reply
      // must not keep feeding audio to the screen.
      if (generation !== this.speechGeneration || (turnId && !this.acceptsTurn(turnId))) break;
      const delivery = await this.speak(
        chunk,
        "reply",
        genId("mirror_audio"),
        // Every chunk carries the same caption id, so the screen keeps
        // revealing one growing message rather than replacing it per sentence.
        messageId,
        turnId,
        // Only the final chunk holds the full text; earlier ones would
        // otherwise each declare the caption complete.
        { captionText: index === chunks.length - 1 ? clean : undefined },
      );
      if (delivery.delivered) anyDelivered = true;
      else if (delivery.suppressed) break;
      else lastError = delivery.error ?? lastError;
    }
    if (!anyDelivered) return { delivered: false, suppressed: true };
    return { delivered: true, ...(lastError ? { error: lastError } : {}) };
  }

  async speak(
    reply: string,
    source: "reply" | "tool" = "reply",
    requestId = genId("mirror_audio"),
    messageId = genId("assistant"),
    turnId?: string,
    opts?: {
      /**
       * Caption to reveal for this audio, when it differs from what is spoken.
       * Chunked replies pass the whole answer on the final chunk so the glass
       * shows one message instead of one per sentence.
       */
      captionText?: string;
    },
  ): Promise<MirrorDelivery> {
    const clean = speakable(reply);
    if (!clean || clean === "[SILENT]") return { delivered: false, suppressed: true };
    if (
      !this.conversationOpen() ||
      !this.deliveryEnabled ||
      this.wakeInProgress ||
      (turnId && !this.acceptsTurn(turnId))
    ) {
      console.log(
        `[mirror] voice suppressed (${source} outside attached conversation): ${clean.slice(0, 120)}`,
      );
      return { delivered: false, suppressed: true };
    }

    this.conversationUntil = Math.max(
      this.conversationUntil,
      Date.now() + MirrorOrchestrator.SPEECH_EXTEND_MS,
    );
    this.prepareAssistantMessage(messageId);
    this.currentPhase = "responding";
    this.queueProjection("responding");
    const generation = this.speechGeneration;
    // Recorded before synthesis: if the mic hears this coming back, we need to
    // recognize it whether or not playback ultimately succeeded.
    this.rememberSpeech(clean);
    // Synthesis is a gap in which pendingAudio is legitimately empty while more
    // speech is still coming. Counting it keeps "finished speaking" honest —
    // otherwise an utterance that finished before the next one registered would
    // open the follow-up window early, and the listening overlay that follows
    // would cut off the rest of the reply.
    this.speechInFlight += 1;
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      this.speechInFlight -= 1;
    };

    const synthBegan = Date.now();
    try {
      const audio = await this.voice.synthesize(clean, this.config);
      const synthMs = Date.now() - synthBegan;
      if (
        generation !== this.speechGeneration ||
        !this.deliveryEnabled ||
        this.wakeInProgress ||
        (turnId && !this.acceptsTurn(turnId))
      ) {
        return { delivered: false, suppressed: true };
      }
      // Intermediate chunks carry no caption: the screen reveals text in step
      // with playback, and letting each sentence declare the message complete
      // would make the caption flicker between sentences.
      // No opts at all means a plain single-utterance speak (tool speech,
      // error notices): it captions itself, as it always has. Only a chunked
      // reply deliberately passes an absent caption for its middle chunks.
      const caption = opts ? opts.captionText : clean;
      const sendBegan = Date.now();
      const delivery = await this.bridge.playAudio(
        {
          base64: audio.base64,
          format: audio.format,
          ...(caption !== undefined ? { text: caption } : {}),
          messageId,
        },
        requestId,
      );
      // Time-to-audio is the whole product here, and this stretch used to be a
      // silent hole in the log: a reply could take ten seconds between "model
      // finished" and "outbound sent" with nothing to say where it went.
      console.log(
        `[mirror] spoke ${clean.length}ch synth=${synthMs}ms` +
          `${audio.engineMs !== undefined ? ` engine=${audio.engineMs}ms` : ""}` +
          `${audio.engine ? ` via=${audio.engine}` : ""} send=${Date.now() - sendBegan}ms`,
      );
      if (delivery.delivered) {
        // Ownership passes to pendingAudio before the count is released, so
        // there is never an instant where this utterance is untracked.
        this.pendingAudio.set(requestId, {
          messageId,
          text: caption ?? clean,
          generation,
        });
        return { delivered: true };
      }
      console.warn(`[mirror] audio was not accepted: ${delivery.error ?? "unknown"}`);
      this.finishAssistantMessage(messageId, clean);
      this.queueProjection("responding");
      release();
      if (this.speechSettled()) await this.settleAfterResponse();
      return { delivered: true, ...(delivery.error ? { error: delivery.error } : {}) };
    } catch (err) {
      console.error(`[mirror] tts failed; caption remains readable: ${safeError(err)}`);
      this.finishAssistantMessage(messageId, clean);
      this.queueProjection("responding");
      release();
      if (this.speechSettled()) await this.settleAfterResponse();
      return { delivered: true };
    } finally {
      release();
    }
  }

  /**
   * True when nothing is speaking and nothing is on its way to speaking.
   *
   * Both halves matter: pendingAudio covers utterances the screen is playing,
   * the counter covers ones still being synthesized. Testing only the former
   * treats the gap between two utterances as the end of the reply.
   */
  private speechSettled(): boolean {
    return this.speechInFlight === 0 && this.pendingAudio.size === 0;
  }

  /**
   * Put the screen back where it belongs after a capture that started no turn.
   *
   * The Pi projects "thinking" the moment it uploads an utterance, and unlike
   * the listening phases that one has no watchdog behind it. Any path that
   * decides the capture was not really a request therefore has to say what the
   * mirror should show instead, or it sits on a spinner indefinitely.
   */
  private restoreProjectionAfterNonTurn(): void {
    if (this.pendingAudio.size > 0) {
      // He is still talking; the reply that was ducked continues.
      this.currentPhase = "responding";
      this.queueProjection("responding");
      return;
    }
    if (this.speechSettled()) {
      void this.settleAfterResponse();
      return;
    }
    this.queueProjection("idle");
  }

  private async settleAfterResponse(): Promise<void> {
    if (!this.deliveryEnabled || !this.conversationOpen() || this.wakeInProgress) return;
    if (mirrorConfig(this.config).followup_window) {
      const delivery = await this.bridge.requestFollowup();
      if (delivery.delivered) return;
      console.warn(`[mirror] follow-up unavailable: ${delivery.error ?? "screen offline"}`);
    }
    if (this.backgroundActive()) {
      this.holdForBackground();
      return;
    }
    this.endConversation();
    this.queueProjection("idle");
  }

  /** Jobs still worth showing — live, and not dismissed by an explicit exit. */
  private waitingJobCount(): number {
    let count = 0;
    for (const id of this.backgroundJobs) if (!this.dismissedJobs.has(id)) count += 1;
    return count;
  }

  /** Should background work be holding the glass right now? */
  private backgroundActive(): boolean {
    if (this.waitingJobCount() === 0) return false;
    if (this.backgroundSince === 0) return false;
    return Date.now() - this.backgroundSince < MirrorOrchestrator.BACKGROUND_MAX_MS;
  }

  /**
   * Keep the dock alive for work that outlives its conversation.
   *
   * The thread is dropped (that exchange is over) but the waterline, the
   * presence and a working line stay, and the volley stays ATTACHED so the
   * eventual result is spoken rather than appearing silently.
   */
  private holdForBackground(): void {
    this.holdingForBackground = true;
    this.deliveryEnabled = true;
    this.conversationUntil = Math.max(
      this.conversationUntil,
      Date.now() + MirrorOrchestrator.BACKGROUND_HOLD_MS,
    );
    this.currentPhase = "working";
    this.queueProjection("working");
  }

  /**
   * Put the running jobs on the glass, and take them off when they finish.
   *
   * Written by the daemon rather than the model, because the model cannot see
   * them: `spawn_agent` runs inside an MCP subprocess, so the turn that
   * started a job ends without ever learning whether it is still going. A
   * roster the model wrote would be a claim about the past.
   *
   * The TTL is the safety net and it is deliberately short. This is re-upserted
   * on every reconcile tick, so a live roster stays fresh indefinitely — but if
   * this process dies, or the watch stops, or the removal below never runs, the
   * widget expires on its own within a tick or two. A status display that
   * outlives the thing it reports is worse than no status display: it says work
   * is happening when nothing is.
   */
  private syncAgentRoster(jobs: readonly MirrorBackgroundJob[]): void {
    const waiting = jobs.filter((job) => !this.dismissedJobs.has(job.id));
    try {
      if (waiting.length === 0) {
        if (this.rosterShown) {
          this.store.removeContent(MirrorOrchestrator.ROSTER_ID, "background.idle");
          this.rosterShown = false;
        }
        return;
      }
      const now = Date.now();
      this.store.upsertContent(
        {
          id: MirrorOrchestrator.ROSTER_ID,
          page: "home",
          // Just above the waterline, beside the presence that is already
          // moving for these same jobs. Low priority: it is a footnote on the
          // conversation, not an answer.
          zone: "lower_third",
          presentation: "widget",
          component: "agent_activity",
          props: {
            jobs: waiting.slice(0, 6).map((job) => ({
              task: job.task.slice(0, 240),
              since: humanSince(now - job.spawnedAtMs),
            })),
          },
          lifespan: "ephemeral",
          priority: -20,
          expiresAtMs: now + MirrorOrchestrator.ROSTER_TTL_MS,
        },
        "background.roster",
      );
      this.rosterShown = true;
    } catch (err) {
      // Never a reason to disturb the conversation. The next tick corrects it,
      // and if it does not, the TTL removes it.
      console.warn(
        `[mirror] could not update the agent roster: ${(err as Error).message.slice(0, 160)}`,
      );
    }
  }

  private renderPassiveReply(text: string): MirrorDelivery {
    try {
      const ttlSeconds = mirrorConfig(this.config).default_ttl_seconds;
      this.store.upsertContent(
        {
          id: "system:last-response",
          page: "home",
          zone: "lower_third",
          presentation: "widget",
          component: "text_block",
          props: {
            eyebrow: "Edmund",
            text,
            tone: "default",
          },
          lifespan: "ephemeral",
          priority: 80,
          expiresAtMs: Date.now() + ttlSeconds * 1_000,
        },
        "channel.final",
      );
      return { delivered: true };
    } catch (err) {
      return { delivered: false, error: safeError(err) };
    }
  }

  private acceptsTurn(turnId: string): boolean {
    return (
      this.activeTurnId === turnId &&
      !this.isIgnored(turnId) &&
      this.deliveryEnabled &&
      !this.wakeInProgress &&
      this.conversationOpen()
    );
  }

  private isIgnored(turnId: string): boolean {
    return this.ignoredTurns.has(turnId);
  }

  private ignoreActiveTurn(): void {
    if (this.activeTurnId) this.ignoredTurns.add(this.activeTurnId);
  }

  /** Remember what we said, so we can recognize it coming back through the mic. */
  private rememberSpeech(text: string): void {
    const now = Date.now();
    this.recentSpeech = this.recentSpeech.filter(
      (entry) => now - entry.at < MirrorOrchestrator.ECHO_MEMORY_MS,
    );
    const words = echoWords(text);
    if (words.size > 0) this.recentSpeech.push({ words, at: now });
  }

  /**
   * True when an utterance is mostly words we just spoke.
   *
   * Word-set containment rather than string matching: STT of room audio garbles
   * order and drops words, so "then we add the tuna and just stir" comes back
   * as a lossy subset of what was said, never as a substring of it.
   */
  private isSelfEcho(transcript: string): boolean {
    const now = Date.now();
    this.recentSpeech = this.recentSpeech.filter(
      (entry) => now - entry.at < MirrorOrchestrator.ECHO_MEMORY_MS,
    );
    if (this.recentSpeech.length === 0) return false;
    const heard = [...echoWords(transcript)];
    // Short utterances are real replies ("yes", "no thanks", "do it") and would
    // trip any overlap test by chance.
    if (heard.length < MirrorOrchestrator.ECHO_MIN_WORDS) return false;
    // Compared against everything recently spoken at once, not utterance by
    // utterance: a reply goes out as several sentences, and the mic captures
    // across those boundaries, so the echo of one capture routinely spans two
    // of them and would clear neither on its own.
    const spoken = new Set<string>();
    for (const entry of this.recentSpeech) {
      for (const word of entry.words) spoken.add(word);
    }
    const shared = heard.filter((word) => spoken.has(word)).length;
    return shared / heard.length >= MirrorOrchestrator.ECHO_OVERLAP;
  }

  private conversationOpen(): boolean {
    if (Date.now() < this.conversationUntil) return true;
    // Work he is waiting on holds the volley past the idle window, so its
    // result reaches him the way he asked for it rather than as a silent
    // repaint of the glass.
    return this.backgroundActive();
  }

  private endConversation(): void {
    this.pendingAudio.clear();
    this.deliveryEnabled = false;
    this.wakeInProgress = false;
    this.conversationUntil = 0;
    this.messages = [];
    this.speechGeneration += 1;
    this.holdingForBackground = false;
    // Deliberately NOT a dismissal. Most calls here are timeouts, errors and
    // screen drops, and a job must survive those — the next reconcile re-opens
    // the dock for it. Only an explicit exit calls dismissBackgroundWork.
    this.backgroundSince = 0;
  }

  /**
   * Stop background work from holding the glass, without cancelling it.
   *
   * "Bye" and Close() are decisions about the SCREEN. The job keeps running
   * and still reports when it finishes; it just stops being a reason to keep
   * the dock lit. Scoped to the jobs live at this moment so a later one is not
   * silently pre-dismissed.
   */
  private dismissBackgroundWork(): void {
    for (const id of this.backgroundJobs) this.dismissedJobs.add(id);
    this.holdingForBackground = false;
    this.backgroundSince = 0;
  }

  private appendMessage(message: MirrorConversationMessage): void {
    this.messages.push(message);
    if (this.messages.length > 12) this.messages.splice(0, this.messages.length - 12);
  }

  private prepareAssistantMessage(messageId: string): void {
    if (this.messages.some((message) => message.id === messageId)) return;
    this.appendMessage({ id: messageId, role: "assistant", text: "", final: false });
  }

  private finishAssistantMessage(messageId: string, text: string): void {
    const existing = this.messages.find((message) => message.id === messageId);
    if (existing) {
      existing.text = text.slice(0, 4_000);
      existing.final = true;
      return;
    }
    this.appendMessage({
      id: messageId,
      role: "assistant",
      text: text.slice(0, 4_000),
      final: true,
    });
  }

  /**
   * Coalesces model text deltas by WebSocket acknowledgement, not time.
   * At most one overlay frame is in flight; if more stream events arrive,
   * the next frame contains the newest complete projection.
   */
  private queueProjection(
    phase: "idle" | "listening" | "thinking" | "working" | "responding",
  ): void {
    this.projectionPhase = phase;
    this.projectionDirty = true;
    if (!this.projectionInFlight) void this.drainProjection();
  }

  private async drainProjection(): Promise<void> {
    if (this.projectionInFlight) return;
    this.projectionInFlight = true;
    try {
      while (this.projectionDirty) {
        this.projectionDirty = false;
        const phase = this.projectionPhase;
        const holding = this.holdingForBackground && this.activeTurnId === null;
        // An EMPTY array, not undefined: the screen treats a missing list as
        // "keep what you had", so omitting it would leave the finished
        // exchange sitting under a dock that is now about something else.
        const messages = holding
          ? []
          : phase === "idle"
            ? undefined
            : this.messages.map((message) => ({ ...message }));
        // The detail only rides along with "working" — that is the phase that
        // can sit unchanged for minutes and needs to prove it is still moving.
        const detail = holding
          ? backgroundDetail(this.waitingJobCount())
          : phase === "working"
            ? this.modelDetail
            : undefined;
        const agents = Math.min(8, this.waitingJobCount());
        await this.bridge.setOverlay({
          phase,
          ...(messages ? { messages } : {}),
          ...(detail ? { detail } : {}),
          ...(agents > 0 ? { agents } : {}),
        });
      }
    } finally {
      this.projectionInFlight = false;
      if (this.projectionDirty) void this.drainProjection();
    }
  }

  private inboundFor(transcript: string, eventId: string): InboundMessage {
    const now = Date.now();
    const rowId = now * 1_000 + (this.syntheticSequence++ % 1_000);
    return {
      rowId,
      msgGuid: `mirror-${eventId}-${genId("turn")}`,
      chatIdentifier: this.sessionKey,
      chatGuid: this.sessionKey,
      isGroup: false,
      fromHandle: this.config.alerts.operator_handle || "mirror-voice",
      fromMe: false,
      text: transcript,
      timestampMs: now,
      attachments: [],
      attachmentTranscripts: {},
      service: "mirror",
      replyToGuid: null,
    };
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

/**
 * The line under WORKING while only background jobs are holding the dock.
 *
 * Same register as the model's own tool notes (lower-case prose, honest about
 * being vague): it exists to prove the mirror has not forgotten, not to
 * itemise what is running.
 */
function backgroundDetail(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count === 1 ? "still working in the background" : `${count} jobs still running`;
}

function assistantMessageId(turnId: string): string {
  return `assistant:${turnId}`.slice(0, 96);
}

function userMessageId(eventId: string): string {
  return `user:${eventId}`.replace(/[^a-zA-Z0-9:_.-]/g, "_").slice(0, 96);
}

/**
 * How long a job has been going, in the coarsest unit that is still true.
 *
 * Seconds on a wall are noise — nobody reads "1 min 47 s" off a mirror, and a
 * figure that changes every second makes the eye return to it. Minutes settle.
 */
function humanSince(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hr" : `${hours} hr`;
}
