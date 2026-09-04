/**
 * Barge-in detection: does a message parked behind an in-flight turn ask
 * to STOP or REDIRECT that turn? If yes, main.ts aborts the session's
 * AbortController — the turn dies, its batch is disposed (ack-covered),
 * and the parked message is re-enqueued as its own fresh turn by
 * handleBatch's finally block, so the model answers the cancel/pivot in
 * seconds instead of after minutes of doomed work.
 *
 * DELIBERATELY CONSERVATIVE. A false positive kills a healthy turn and
 * its warm worker (cold respawn, lost tool work); a miss just parks the
 * message for the coalesce gate exactly as before. So only two shapes
 * qualify:
 *   1. the ENTIRE message is a recognized cancel/hold word, or
 *   2. it opens with a redirect word AND contains an explicit
 *      cancel/replace verb shortly after ("wait, don't send that",
 *      "no cancel it", "actually forget it, do X instead").
 * Plain follow-ups ("actually can you also…", "no worries") never match.
 */

/** The whole (short) message IS the cancel. */
const FULL_CANCEL_RE =
  /^\s*(stop|stop stop|cancel( that| it)?|abort( that| it)?|nevermind|never ?mind|forget (it|that)|scratch that|wait,? stop|no,? stop|wait|hold on|hang on|hold up)[\s.!…]*$/i;

/** Redirect opener + explicit cancel/replace verb within the first ~80 chars. */
const PIVOT_RE =
  /^\s*(wait|no|actually|hold on|hang on)\b[\s\S]{0,80}?\b(stop|cancel|abort|don'?t|do not|forget (it|that)|nevermind|never ?mind|scratch that|instead|not that)\b/i;

export function isBargeIn(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 200) return false;
  return FULL_CANCEL_RE.test(t) || PIVOT_RE.test(t);
}
