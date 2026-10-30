/**
 * Where the time goes between the caller finishing and Edmund's first sound,
 * logged once per exchange. A voice agent is judged on that gap: people leave
 * ~200 ms between turns, and past ~1.5 s a caller assumes the line is broken.
 * It has several stages that each moved when the endpointing, the model or
 * the voice changed, so each is measured rather than inferred.
 */

export type ExchangeTrace = {
  /** When the caller actually stopped talking (their audio's clock). */
  stoppedAt: number | null;
  /** When the pause, with the turn detector's verdict, reached the manager. */
  pausedAt: number | null;
  probability: number | null;
  /** Their last final transcript. */
  finalAt: number | null;
  /** The turn handed to the conversation. */
  handoffAt: number | null;
  /** Edmund's first words written. */
  wordsAt: number | null;
  /** His first speech sent to be played. */
  soundAt: number | null;
};

export function newTrace(): ExchangeTrace {
  return {
    stoppedAt: null,
    pausedAt: null,
    probability: null,
    finalAt: null,
    handoffAt: null,
    wordsAt: null,
    soundAt: null,
  };
}

/**
 * The exchange as log fields, each stage in ms after the caller stopped (or
 * after their final transcript, when the provider could not say when they
 * stopped). Null until Edmund has made a sound in reply.
 */
export function describeTrace(trace: ExchangeTrace): Record<string, number | string> | null {
  if (trace.handoffAt === null || trace.soundAt === null) return null;
  const base = trace.stoppedAt ?? trace.finalAt ?? trace.handoffAt;
  const after = (at: number | null) => (at === null ? "-" : Math.round(at - base));
  return {
    gap_ms: Math.round(trace.soundAt - base),
    from: trace.stoppedAt !== null ? "speech end" : "final transcript",
    pause_ms: after(trace.pausedAt),
    turn_p: trace.probability === null ? "-" : Number(trace.probability.toFixed(2)),
    final_ms: after(trace.finalAt),
    handoff_ms: after(trace.handoffAt),
    words_ms: after(trace.wordsAt),
    sound_ms: after(trace.soundAt),
  };
}
