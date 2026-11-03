/**
 * Hearing for a call, from raw audio, in the daemon.
 *
 * A provider feeds the caller's audio in (16 kHz mono 16-bit) and gets back
 * the same events Apple's recogniser used to produce: speech started, a
 * pause with the turn detector's verdict, words in progress, words settled.
 * The manager cannot tell the difference, and every provider hears the same
 * way.
 *
 * Why it is shaped like this. Hearing used to be a recognition session that
 * lived for the whole call, and a turn could only end when that session
 * produced a final transcript. When the session died, nothing told a deaf
 * call from a silent caller (2026-10-29, twice). Here the turn is cut by
 * code we own, from the audio's energy, and each stretch of speech is sent
 * whole to the transcriber as one request. There is nothing long-lived to
 * die, so there is nothing to watch, restart or replay:
 *
 *   - Every stretch of speech gets exactly one answer: its words, nothing
 *     (a cough), or INAUDIBLE when the transcriber could not say. The last
 *     reaches Edmund, who asks them to say it again, the way a person would.
 *   - Events leave in the order the audio happened. A pause and its words
 *     leave together, so a finished turn is never handed over in two pieces;
 *     the next stretch's start waits for the previous stretch's words.
 *   - Where things happened is counted in samples, and turned into wall
 *     time from the latest audio's arrival, never from the call's first
 *     sample: audio that arrives even 1% slow (a stalled tab, a busy client)
 *     put "they stopped" 0.5 s early by a minute in, and every timing after
 *     it read half a second too slow.
 */

import type { ProviderEvent } from "./types.ts";

const RATE = 16_000;
const SAMPLES_PER_MS = RATE / 1000;
/** Audio kept: longer than any one stretch is allowed to grow. */
const RING_SECONDS = 60;
/** A stretch this long is transcribed and a new one begun, pause or not. */
const MAX_STRETCH_SAMPLES = 30 * RATE;
/** Before the first voiced frame, so a soft onset ("h", "f") is not clipped. */
const PREROLL_SAMPLES = 200 * SAMPLES_PER_MS;
/** After the pause began: the tail of the last word. */
const TAIL_SAMPLES = 200 * SAMPLES_PER_MS;
/** What the turn detector judges: the last 8 s up to the pause. */
const VERDICT_SAMPLES = 8 * RATE;
/** Words in progress are read every this much speech, for barge-in. */
const PARTIAL_EVERY_SAMPLES = 400 * SAMPLES_PER_MS;
/** ...from at most the last this much of the stretch. */
const PARTIAL_WINDOW_SAMPLES = 8 * RATE;

/**
 * What Edmund is told when someone spoke and the transcriber could not say
 * what. He asks them to repeat it; silence would leave them waiting.
 */
export const INAUDIBLE = "[inaudible]";

export type EarDeps = {
  /** Words in 16 kHz mono 16-bit PCM; "" for none, null when it could not say. */
  transcribe: (pcm: Uint8Array) => Promise<{ text: string } | null>;
  /** Probability the caller has finished, for base64 PCM; null when it could not say. */
  turnVerdict: (pcmBase64: string) => Promise<number | null>;
  emit: (event: ProviderEvent) => void;
  /** Each clip the turn detector scored, for tuning turn-taking. */
  onTurnClip?: (pcmBase64: string, probability: number | null) => void;
  now?: () => number;
};

/**
 * When someone is talking, from the energy of 20 ms frames against an
 * adaptive noise floor: speech after 60 ms voiced, a pause after 240 ms
 * quiet. The same detector the call-audio helper ran (RecentAudio.swift).
 */
export class VoiceActivity {
  private static readonly FRAME = 320;
  private static readonly SPEECH_FRAMES_TO_START = 3;
  private static readonly QUIET_FRAMES_TO_PAUSE = 12;
  private floorDb = -70;
  private speechRun = 0;
  private quietRun = 0;
  private speaking = false;
  private firstQuietSample = 0;
  private firstVoicedSample = 0;
  private frame = new Float64Array(VoiceActivity.FRAME);
  private fill = 0;
  private frameStart = 0;

  talking(): boolean {
    return this.speaking;
  }

  /** Feeds samples starting at `startSample`; returns where speech started and pauses began. */
  feed(samples: Int16Array, startSample: number): Array<["start" | "pause", number]> {
    const events: Array<["start" | "pause", number]> = [];
    for (let i = 0; i < samples.length; i++) {
      if (this.fill === 0) this.frameStart = startSample + i;
      this.frame[this.fill++] = samples[i]! / 32768;
      if (this.fill < VoiceActivity.FRAME) continue;
      this.fill = 0;
      let energy = 0;
      for (const x of this.frame) energy += x * x;
      const db = 10 * Math.log10(Math.max(energy / VoiceActivity.FRAME, 1e-12));
      // The floor follows quiet quickly and loud slowly, so a long sentence
      // does not become the new "quiet".
      this.floorDb = db < this.floorDb ? db : this.floorDb + 0.02;
      const voiced = db > Math.max(-50, this.floorDb + 12);
      if (voiced) {
        if (this.speechRun === 0) this.firstVoicedSample = this.frameStart;
        this.speechRun += 1;
        this.quietRun = 0;
        if (this.speechRun >= VoiceActivity.SPEECH_FRAMES_TO_START && !this.speaking) {
          this.speaking = true;
          events.push(["start", this.firstVoicedSample]);
        }
      } else {
        if (this.quietRun === 0) this.firstQuietSample = this.frameStart;
        this.quietRun += 1;
        this.speechRun = 0;
        if (this.speaking && this.quietRun >= VoiceActivity.QUIET_FRAMES_TO_PAUSE) {
          this.speaking = false;
          events.push(["pause", this.firstQuietSample]);
        }
      }
    }
    return events;
  }
}

type Stretch = {
  seq: number;
  /** First sample of the stretch, preroll included. */
  start: number;
  /** Sample at which the next partial read is due. */
  nextPartial: number;
  /** Set once its pause is found: no more partials. */
  closed: boolean;
};

export class Ear {
  private readonly deps: EarDeps;
  private readonly now: () => number;
  private readonly ring = new Int16Array(RING_SECONDS * RATE);
  /** Samples fed this session; ring holds the last RING_SECONDS of them. */
  private total = 0;
  /** When the latest audio arrived: the wall time of sample `total`. */
  private arrivedMs = 0;
  private activity = new VoiceActivity();
  private stretch: Stretch | null = null;
  private seq = 0;
  /** Highest stretch whose start has been emitted. */
  private announced = 0;
  private partialBusy = false;
  /** Events leave in audio order: each waits for the one before. */
  private chain: Promise<void> = Promise.resolve();
  /** Bumped by begin() and end(); work from an older session is dropped. */
  private session = 0;
  private listening = false;

  constructor(deps: EarDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Start hearing a new call: a fresh clock and nothing carried over. */
  begin(): void {
    this.session += 1;
    this.listening = true;
    this.total = 0;
    this.arrivedMs = 0;
    this.activity = new VoiceActivity();
    this.stretch = null;
    this.announced = this.seq;
    this.partialBusy = false;
    this.chain = Promise.resolve();
  }

  end(): void {
    this.session += 1;
    this.listening = false;
    this.stretch = null;
  }

  /** The caller's audio, in arrival order. Ignored unless listening. */
  feed(samples: Int16Array): void {
    if (!this.listening || samples.length === 0) return;
    this.arrivedMs = this.now();
    const start = this.total;
    this.write(samples);
    for (const [kind, at] of this.activity.feed(samples, start)) {
      if (kind === "start") this.opened(at);
      else this.paused(at);
    }
    const stretch = this.stretch;
    if (!stretch) return;
    if (this.total - stretch.start >= MAX_STRETCH_SAMPLES) {
      // A monologue with no pause: settle what is held and carry on.
      this.settle(stretch, this.total, false);
      this.opened(this.total);
    } else if (this.total >= stretch.nextPartial) {
      stretch.nextPartial = this.total + PARTIAL_EVERY_SAMPLES;
      void this.partial(stretch);
    }
  }

  private opened(at: number): void {
    const stretch: Stretch = {
      seq: ++this.seq,
      start: Math.max(0, at - PREROLL_SAMPLES, this.total - this.ring.length),
      nextPartial: at + PARTIAL_EVERY_SAMPLES,
      closed: false,
    };
    this.stretch = stretch;
    const session = this.session;
    this.enqueue(session, async () => {
      this.announced = stretch.seq;
      this.deps.emit({ type: "speech", talking: true, atMs: this.wallAt(at) });
    });
  }

  private paused(at: number): void {
    const stretch = this.stretch;
    if (!stretch) return;
    this.settle(stretch, Math.min(this.total, at + TAIL_SAMPLES), true, at);
  }

  /**
   * Close a stretch: transcribe it whole and, at a real pause, ask the turn
   * detector too. Both run now; their answers leave together, in order.
   */
  private settle(stretch: Stretch, end: number, withVerdict: boolean, pauseAt = end): void {
    stretch.closed = true;
    if (this.stretch === stretch) this.stretch = null;
    const session = this.session;
    const words = this.deps.transcribe(this.slice(stretch.start, end));
    const verdictClip = withVerdict ? this.base64(this.slice(end - VERDICT_SAMPLES, end)) : "";
    const verdict = withVerdict
      ? this.deps.turnVerdict(verdictClip).catch(() => null)
      : Promise.resolve(null);
    const stoppedAtMs = this.wallAt(pauseAt);
    this.enqueue(session, async () => {
      const [heard, probability] = await Promise.all([words.catch(() => null), verdict]);
      if (session !== this.session) return;
      if (withVerdict) {
        this.deps.onTurnClip?.(verdictClip, probability);
        this.deps.emit({ type: "pause", stoppedAtMs, probability });
      }
      const text = heard === null ? INAUDIBLE : heard.text.trim();
      if (!text) return;
      this.deps.emit({
        type: "heard",
        text,
        final: true,
        atMs: this.now(),
        spokeUntilMs: stoppedAtMs,
      });
    });
  }

  /** Words so far in the open stretch, for barge-in. Skipped while one is still out. */
  private async partial(stretch: Stretch): Promise<void> {
    if (this.partialBusy) return;
    this.partialBusy = true;
    const session = this.session;
    try {
      const from = Math.max(stretch.start, this.total - PARTIAL_WINDOW_SAMPLES);
      const heard = await this.deps.transcribe(this.slice(from, this.total)).catch(() => null);
      // Only while its stretch is still open and announced: after the pause,
      // the stretch's settled words say it better.
      if (session !== this.session || stretch.closed || this.announced < stretch.seq) return;
      const text = heard?.text.trim();
      if (text) this.deps.emit({ type: "heard", text, final: false, atMs: this.now() });
    } finally {
      if (session === this.session) this.partialBusy = false;
    }
  }

  private enqueue(session: number, step: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (session === this.session) await step();
    });
  }

  private wallAt(sample: number): number {
    return Math.round(this.arrivedMs - (this.total - sample) / SAMPLES_PER_MS);
  }

  private write(samples: Int16Array): void {
    const size = this.ring.length;
    let at = this.total % size;
    let offset = 0;
    while (offset < samples.length) {
      const n = Math.min(samples.length - offset, size - at);
      this.ring.set(samples.subarray(offset, offset + n), at);
      offset += n;
      at = 0;
    }
    this.total += samples.length;
  }

  /** Samples [from, to) as little-endian bytes, clamped to what is still held. */
  private slice(from: number, to: number): Uint8Array {
    const size = this.ring.length;
    const start = Math.max(from, this.total - size, 0);
    const end = Math.min(to, this.total);
    if (end <= start) return new Uint8Array(0);
    const out = new Int16Array(end - start);
    for (let i = start, j = 0; i < end; i++, j++) out[j] = this.ring[i % size]!;
    return new Uint8Array(out.buffer);
  }

  private base64(pcm: Uint8Array): string {
    return Buffer.from(pcm).toString("base64");
  }
}
