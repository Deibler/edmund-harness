/**
 * Edmund's side of a call: model text in, speech out, as fast as it streams.
 *
 * The mirror speaks a finished reply; a call cannot wait that long. Text
 * deltas are cut into sentences as they arrive (takeSentences), each sentence
 * is synthesised and queued while the next is still being written, so the
 * caller hears the first sentence while the model writes the rest. Narration
 * between tool calls ("let me check") is spoken too, which on a call is
 * exactly what a person would do.
 *
 * Barge-in drops everything not yet heard and mutes the rest of that turn.
 * What was cut off is kept, so the next turn can be told where Edmund was
 * interrupted. Every chunk reports back once played or dropped, which is how
 * the transcript knows what the caller actually heard.
 */

import { CONTROL_SENTINELS } from "../channels/sanitize-outbound.ts";
import { genId } from "../util/ids.ts";
import { log } from "../util/log.ts";
import { speakable, speechChunks, takeSentences } from "../voice/text.ts";
import type { VoiceOutcome } from "./binding.ts";
import type { CallProvider, Speaker } from "./types.ts";

const THREAD_MARKER = /^\s*\[(?:thread(?:ed)?|reply)\]\s*/i;

/** A sentence that is nothing but a control sentinel (KEEP_QUIET, …). */
function isSentinel(text: string): boolean {
  const bare = text.replace(/[^A-Za-z_]/g, "").toUpperCase();
  return (CONTROL_SENTINELS as readonly string[]).includes(bare);
}

/** Model text as it should be said, or "" when there is nothing to say. */
function toSpeech(text: string): string {
  const spoken = speakable(text.replace(THREAD_MARKER, ""));
  return isSentinel(spoken) ? "" : spoken;
}

export type VoiceOutDeps = {
  speaker: Speaker;
  provider: Pick<CallProvider, "say" | "flush">;
  /** Each piece of Edmund's speech once it was heard, or dropped unheard. */
  onSaid: (text: string, heard: boolean) => void;
  /**
   * Speech is being handed to the provider: part of a reply, or an aside (a
   * line said for Edmund while his reply is on its way, see `aside`). Told
   * apart so the time to his reply is never measured to a "hmm".
   */
  onSpeaking?: (kind: "reply" | "aside") => void;
};

type TurnTally = { queued: number; failed: number };

/**
 * What the caller did not hear, and why: they talked over Edmund, or they
 * kept talking before he answered and his reply to the earlier part was
 * never said.
 */
export type CutOff = { kind: "talked-over" | "kept-talking"; text: string };

/** How long the text may pause on a finished sentence before it is said. */
const SENTENCE_IDLE_MS = 200;
/**
 * A reply's first sentence, once it has run this long without ending, is
 * started at a clause break instead. Kokoro synthesises a whole chunk before
 * any of it plays, in 0.26 s plus about 0.18 s per second of speech
 * (2026-11-12): a 120-character opening sentence is 1.5 s of waiting, its
 * first clause 0.8 s. One reply in six opens with a sentence over 60
 * characters (126 replies, 2026-10-29 to 11-11).
 */
const FIRST_CLAUSE_AFTER_CHARS = 60;
/** ...and the clause has to be worth saying alone ("Well," is not). */
const FIRST_CLAUSE_MIN_CHARS = 25;
const CLAUSE_BREAK = /[,;:]\s+|\s+[—–-]\s+/g;

/** The first clause of an unfinished opening sentence, if it is long enough to start on. */
export function takeFirstClause(buffer: string): { clause: string; rest: string } | null {
  if (buffer.length < FIRST_CLAUSE_AFTER_CHARS) return null;
  for (const match of buffer.matchAll(CLAUSE_BREAK)) {
    const end = match.index + match[0].trimEnd().length;
    const clause = buffer.slice(0, end).trim();
    if (clause.length < FIRST_CLAUSE_MIN_CHARS) continue;
    // "at 7:30 pm" and "82,400" are not clause breaks; a break is followed by a word.
    const rest = buffer.slice(match.index + match[0].length);
    if (!/^[\p{L}"'(]/u.test(rest)) continue;
    return { clause, rest };
  }
  return null;
}

export class VoiceOut {
  private readonly deps: VoiceOutDeps;
  private currentTurn: string | null = null;
  private buffer = "";
  private readonly streamed = new Set<string>();
  private readonly muted = new Set<string>();
  private readonly tallies = new Map<string, TurnTally>();
  /** Bumped by every barge-in; work queued under an older one is dropped. */
  private generation = 0;
  private chain: Promise<void> = Promise.resolve();
  /** Chunks handed to the provider and not yet reported played or dropped. */
  private readonly pending = new Map<string, string>();
  /** Which of those are asides, not part of any reply. */
  private readonly asides = new Set<string>();
  /** Lines synthesised ahead of need, by voice and text (see `prepare`). */
  private readonly prepared = new Map<
    string,
    Promise<{ pcm: Uint8Array; sampleRate: number } | null>
  >();
  /** Anything at all has been handed to the provider on this call. */
  private everSpoke = false;
  private cutOff: CutOff | null = null;
  /**
   * A reply the caller talked past before it was said, held until it is
   * clear whether what they said next was for Edmund: if it becomes their
   * turn the reply is dropped and the next one answers everything; if it was
   * not (someone in the background, a cough) it is said after all. Dropping
   * it outright left a caller in 18 s of silence on 2026-10-29: background
   * talk cancelled Edmund's reply and never became a turn of its own.
   */
  private superseded: {
    turnId: string;
    text: string | null;
    decision: "hold" | "release" | "drop";
  } | null = null;
  /** Whether the current turn has sent anything to be spoken yet. */
  private turnQueued = false;
  /** Speaks a finished last sentence once the text stops coming (see delta). */
  private idleFlush: ReturnType<typeof setTimeout> | null = null;
  /** Closed while the call rings: speech is synthesised but not yet sent. */
  private gate: Promise<void> = Promise.resolve();
  private closed: "text" | "drop" | null = null;
  private openGate: (() => void) | null = null;
  private audioReady: Promise<void>;
  private markAudioReady: () => void = () => {};

  constructor(deps: VoiceOutDeps) {
    this.deps = deps;
    this.audioReady = new Promise((resolve) => {
      this.markAudioReady = resolve;
    });
  }

  /** Synthesise but do not send until `release` (the call is not up yet). */
  hold(): void {
    if (this.openGate) return;
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  release(): void {
    this.openGate?.();
    this.openGate = null;
  }

  /**
   * The call is over; anything not yet sent is dropped. A reply still waiting
   * to be spoken then reports "unavailable" (so it goes out as a text) or
   * "silent" (so it is dropped), as the caller decides.
   */
  close(pending: "text" | "drop"): void {
    this.closed = pending;
    this.generation += 1;
    this.release();
  }

  /** Resolves once the first speech is synthesised: the greeting is ready. */
  firstAudioReady(): Promise<void> {
    return this.audioReady;
  }

  /** Something has been handed to the provider to play, on this call. */
  hasSpoken(): boolean {
    return this.everSpoke;
  }

  /**
   * Synthesise a line now and keep it, so it can be said the instant it is
   * wanted. Kept per voice: Edmund can change his voice mid-call, and a line
   * kept in the old one would be someone else interrupting.
   */
  prepare(text: string): void {
    if (this.closed) return;
    const key = this.preparedKey(text);
    if (this.prepared.has(key)) return;
    this.prepared.set(
      key,
      this.deps.speaker.synthesize(text).catch(() => null),
    );
  }

  private preparedKey(text: string): string {
    return `${this.deps.speaker.voiceKey?.() ?? ""}|${text}`;
  }

  /**
   * Say a line for Edmund that is not part of any reply: "Hello?" on a call
   * that connected before his opening line was written, a "hmm" while a
   * reply is slow to come. Only into silence: never while he is speaking or
   * while speech is held, and it does not count as his reply having begun,
   * so a caller who talks again before the reply still has it held for them.
   * False when it was not said.
   */
  aside(text: string): boolean {
    if (this.closed || this.openGate || this.pending.size > 0) return false;
    if (this.currentTurn !== null && (this.turnQueued || this.muted.has(this.currentTurn)))
      return false;
    if (this.superseded) return false;
    this.prepare(text);
    const audio = this.prepared.get(this.preparedKey(text));
    const generation = this.generation;
    this.chain = this.chain.then(async () => {
      if (generation !== this.generation || this.closed) return;
      const ready = await audio;
      // The reply got there first: it needs no introduction now.
      if (!ready || generation !== this.generation || this.pending.size > 0) return;
      const chunkId = genId("aside");
      this.pending.set(chunkId, text);
      this.asides.add(chunkId);
      this.everSpoke = true;
      this.deps.onSpeaking?.("aside");
      try {
        await this.deps.provider.say(chunkId, ready.pcm, ready.sampleRate);
      } catch (err) {
        this.pending.delete(chunkId);
        this.asides.delete(chunkId);
        log.warn("calls", "could not queue an aside", { err: (err as Error).message });
      }
    });
    return true;
  }

  /** True while Edmund has speech queued or playing. */
  speaking(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Resolves once everything Edmund has said so far has played, including a
   * last sentence still being written and speech still being synthesised, or
   * after `timeoutMs`. Hanging up waits on it: the first live call hung up
   * the instant end_call ran, mid-sentence.
   */
  async drained(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    if (this.currentTurn) this.flushBuffer(this.currentTurn);
    await Promise.race([this.chain, pause(timeoutMs)]);
    while (this.pending.size > 0 && Date.now() < deadline) await pause(50);
  }

  beginTurn(turnId: string): void {
    this.currentTurn = turnId;
    this.buffer = "";
    this.turnQueued = false;
  }

  /** A turn is under way and has not said anything yet. */
  awaitingFirstWords(): boolean {
    return this.currentTurn !== null && !this.turnQueued && !this.muted.has(this.currentTurn);
  }

  /**
   * The caller started talking again before Edmund said a word of his reply.
   * The reply is not said: answering each pause in turn made a call feel
   * like a queue ("a to b to c to d"). It is not cancelled either, since an
   * interrupt recycles the worker and costs a cold start. Its text becomes
   * the next turn's cut-off, so Edmund knows they never heard it and answers
   * everything they said in one reply.
   */
  supersede(): void {
    const turn = this.currentTurn;
    if (!turn || this.turnQueued || this.superseded) return;
    this.muted.add(turn);
    this.superseded = { turnId: turn, text: null, decision: "hold" };
    this.generation += 1;
    this.buffer = "";
  }

  /** A reply is being held (see `superseded`). */
  holding(): boolean {
    return this.superseded !== null;
  }

  /** What they said was not a turn after all: say the held reply. */
  releaseHeld(): void {
    const held = this.superseded;
    if (!held) return;
    if (held.text === null) {
      held.decision = "release";
      return;
    }
    this.superseded = null;
    for (const chunk of speechChunks(toSpeech(held.text))) this.enqueue(chunk, genId("held_reply"));
  }

  /** They took their turn: the held reply goes unsaid, and the next turn is told. */
  dropHeld(): void {
    const held = this.superseded;
    if (!held) return;
    if (held.text === null) {
      held.decision = "drop";
      return;
    }
    this.superseded = null;
    if (held.text.trim()) this.cutOff = { kind: "kept-talking", text: held.text.trim() };
  }

  delta(turnId: string, text: string): void {
    if (this.closed || turnId !== this.currentTurn || this.muted.has(turnId)) return;
    this.streamed.add(turnId);
    this.buffer += text;
    const { sentences, rest } = takeSentences(this.buffer);
    this.buffer = rest;
    for (const sentence of sentences) this.enqueue(sentence, turnId);
    // Nothing said yet and the opening sentence is running long: start on
    // its first clause rather than wait for all of it.
    if (!this.turnQueued) {
      const opening = takeFirstClause(this.buffer);
      if (opening) {
        this.buffer = opening.rest;
        this.enqueue(opening.clause, turnId);
      }
    }
    // A sentence is only known to be over when the next one begins, so the
    // last one before a tool call waited for the whole tool: "On it,
    // texting you now." sat 4.8 s while the text was written and sent. If
    // the text pauses on a finished sentence, say it.
    if (this.idleFlush) clearTimeout(this.idleFlush);
    this.idleFlush = null;
    if (/[.!?]["')\]]*\s*$/.test(this.buffer)) {
      this.idleFlush = setTimeout(() => {
        this.idleFlush = null;
        if (this.currentTurn === turnId && !this.muted.has(turnId)) this.flushBuffer(turnId);
      }, SENTENCE_IDLE_MS);
    }
  }

  /**
   * The reply a turn (or a cron wake-up) is delivering. A turn that streamed
   * has said all of it but its unfinished last sentence; a reply that did not
   * stream is said whole.
   */
  async deliver(text: string, turnId?: string): Promise<VoiceOutcome> {
    if (this.closed) return this.closed === "text" ? "unavailable" : "silent";
    const label = turnId ?? genId("voice_reply");
    const held = this.superseded;
    if (turnId && held?.turnId === turnId) {
      if (held.decision === "hold") {
        held.text = text;
        return "silent";
      }
      this.superseded = null;
      if (held.decision === "drop") {
        if (text.trim()) this.cutOff = { kind: "kept-talking", text: text.trim() };
        return "silent";
      }
      // Released before it was written: say it now, as any reply.
      this.muted.delete(turnId);
      this.streamed.delete(turnId);
    }
    if (turnId && this.muted.has(turnId)) return "silent";
    if (turnId && this.streamed.has(turnId)) {
      this.flushBuffer(turnId);
    } else {
      for (const chunk of speechChunks(toSpeech(text))) this.enqueue(chunk, label);
    }
    await this.chain;
    const tally = this.tallies.get(label) ?? { queued: 0, failed: 0 };
    if (!turnId) this.tallies.delete(label);
    if (tally.queued > 0) return "spoken";
    if (this.closed) return this.closed === "text" ? "unavailable" : "silent";
    return tally.failed > 0 ? "unavailable" : "silent";
  }

  /** The turn is over: say what it left unsaid, unless it was interrupted. */
  settle(
    turnId: string,
    outcome: "tool-only" | "silent" | "error" | "interrupted" | "delivered",
  ): void {
    if (turnId === this.currentTurn) {
      if (outcome === "tool-only") this.flushBuffer(turnId);
      this.buffer = "";
      this.currentTurn = null;
    }
    this.streamed.delete(turnId);
    this.muted.delete(turnId);
    // Tallies for turns are read by deliver(), which has already run.
    this.tallies.delete(turnId);
  }

  /**
   * The caller started talking over Edmund. Stop at once, say nothing more of
   * this turn, and remember what they did not get to hear.
   */
  async bargeIn(): Promise<void> {
    // Only an aside is playing and the reply itself has not begun: they are
    // not talking over his answer, they are still talking. Stop the aside
    // and hold the reply, exactly as if he had been silent.
    if (this.currentTurn && !this.turnQueued && this.onlyAsidesPending()) {
      this.supersede();
      await this.deps.provider.flush().catch(() => {});
      return;
    }
    this.generation += 1;
    if (this.currentTurn) this.muted.add(this.currentTurn);
    // An aside they talked over is not something they missed.
    const unheard = [...this.pending].filter(([id]) => !this.asides.has(id)).map(([, t]) => t);
    if (this.buffer.trim()) unheard.push(this.buffer.trim());
    this.buffer = "";
    if (unheard.length > 0) this.cutOff = { kind: "talked-over", text: unheard.join(" ") };
    await this.deps.provider.flush().catch((err: unknown) => {
      log.warn("calls", "flush failed", { err: (err as Error).message });
    });
  }

  /** What the caller last did not hear, once. */
  takeCutOff(): CutOff | null {
    const text = this.cutOff;
    this.cutOff = null;
    return text;
  }

  /** The provider finished (or dropped) a chunk. */
  onSpoken(chunkId: string, played: boolean): void {
    const text = this.pending.get(chunkId);
    if (text === undefined) return;
    this.pending.delete(chunkId);
    this.asides.delete(chunkId);
    this.deps.onSaid(text, played);
  }

  private onlyAsidesPending(): boolean {
    if (this.pending.size === 0) return false;
    for (const id of this.pending.keys()) if (!this.asides.has(id)) return false;
    return true;
  }

  private flushBuffer(turnId: string): void {
    const tail = this.buffer.trim();
    this.buffer = "";
    if (tail) this.enqueue(tail, turnId);
  }

  private tally(label: string): TurnTally {
    let tally = this.tallies.get(label);
    if (!tally) {
      tally = { queued: 0, failed: 0 };
      this.tallies.set(label, tally);
    }
    return tally;
  }

  private enqueue(raw: string, label: string): void {
    // After the call ends a reply still streaming must not be synthesised and
    // played into a line nobody is on (the first live call played 36 s of
    // one); deliver() reports it unavailable and it goes out as a text.
    if (this.closed) return;
    const text = toSpeech(raw);
    if (!text) return;
    const generation = this.generation;
    const tally = this.tally(label);
    if (label === this.currentTurn) this.turnQueued = true;
    this.chain = this.chain.then(async () => {
      if (generation !== this.generation) return;
      const audio = await this.deps.speaker.synthesize(text).catch(() => null);
      if (!audio) {
        tally.failed += 1;
        return;
      }
      this.markAudioReady();
      await this.gate;
      if (generation !== this.generation) return;
      const chunkId = genId("say");
      this.pending.set(chunkId, text);
      this.everSpoke = true;
      this.deps.onSpeaking?.("reply");
      try {
        await this.deps.provider.say(chunkId, audio.pcm, audio.sampleRate);
        tally.queued += 1;
      } catch (err) {
        this.pending.delete(chunkId);
        tally.failed += 1;
        log.warn("calls", "could not queue speech", { err: (err as Error).message });
      }
    });
  }
}
