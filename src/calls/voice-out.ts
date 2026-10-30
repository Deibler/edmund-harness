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
};

type TurnTally = { queued: number; failed: number };

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
  private cutOff: string | null = null;
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

  /** True while Edmund has speech queued or playing. */
  speaking(): boolean {
    return this.pending.size > 0;
  }

  beginTurn(turnId: string): void {
    this.currentTurn = turnId;
    this.buffer = "";
  }

  delta(turnId: string, text: string): void {
    if (turnId !== this.currentTurn || this.muted.has(turnId)) return;
    this.streamed.add(turnId);
    this.buffer += text;
    const { sentences, rest } = takeSentences(this.buffer);
    this.buffer = rest;
    for (const sentence of sentences) this.enqueue(sentence, turnId);
  }

  /**
   * The reply a turn (or a cron wake-up) is delivering. A turn that streamed
   * has said all of it but its unfinished last sentence; a reply that did not
   * stream is said whole.
   */
  async deliver(text: string, turnId?: string): Promise<VoiceOutcome> {
    if (this.closed) return this.closed === "text" ? "unavailable" : "silent";
    const label = turnId ?? genId("voice_reply");
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
    this.generation += 1;
    if (this.currentTurn) this.muted.add(this.currentTurn);
    const unheard = [...this.pending.values()];
    if (this.buffer.trim()) unheard.push(this.buffer.trim());
    this.buffer = "";
    if (unheard.length > 0) this.cutOff = unheard.join(" ");
    await this.deps.provider.flush().catch((err: unknown) => {
      log.warn("calls", "flush failed", { err: (err as Error).message });
    });
  }

  /** What Edmund was saying when last interrupted, once. */
  takeCutOff(): string | null {
    const text = this.cutOff;
    this.cutOff = null;
    return text;
  }

  /** The provider finished (or dropped) a chunk. */
  onSpoken(chunkId: string, played: boolean): void {
    const text = this.pending.get(chunkId);
    if (text === undefined) return;
    this.pending.delete(chunkId);
    this.deps.onSaid(text, played);
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
    const text = toSpeech(raw);
    if (!text) return;
    const generation = this.generation;
    const tally = this.tally(label);
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
