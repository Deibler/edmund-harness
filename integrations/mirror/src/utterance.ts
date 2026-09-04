/**
 * What a person actually said, decided from a transcript alone.
 *
 * Everything here is a pure function of one string. The orchestrator owns the
 * conversation's state machine and consults these to answer four questions
 * about a capture: was it addressed to Edmund, was it Edmund's own voice
 * coming back, where does the name end and the request begin, and does the
 * request mean "go away" or "stop".
 *
 * They live together because they share one vocabulary — the wake words, and
 * the specific ways a transcriber mangles them — and drifting copies of that
 * list in four places is how a mirror ends up answering to "human".
 */

/**
 * Content words for echo comparison. Filler and function words are dropped:
 * they appear in nearly every sentence, so keeping them would make unrelated
 * speech look like an echo.
 */
const ECHO_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "i",
  "in",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "of",
  "on",
  "or",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "to",
  "up",
  "was",
  "we",
  "were",
  "what",
  "when",
  "which",
  "with",
  "you",
  "your",
]);

export function echoWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !ECHO_STOP_WORDS.has(word));
  return new Set(words);
}

/**
 * Does this utterance actually address Edmund by name?
 *
 * Only consulted to decide whether speech heard DURING playback is a real
 * interruption. Matches the same mishearings stripInvocation() tolerates, since
 * both are looking at the same recognizer's output, and looks anywhere in the
 * line — "stop, Edmund" is as much an interruption as "Edmund, stop".
 */
export function mentionsInvocation(transcript: string): boolean {
  return /\b(edmund|edmond|edmunds|edman|admund|admit)\b/i.test(transcript);
}

/**
 * Was this capture addressed to Edmund at all?
 *
 * COMPENSATING CONTROL — delete this when the Pi runs a real wake model.
 *
 * Verifying a wake by string-matching a transcript is not how wake words are
 * done, and a curated list of mishearings compared by edit distance is a
 * heuristic pile, not a design. It exists because the detector upstream of it
 * emits no confidence at all: the Pi decodes a general ASR model against a
 * grammar whose whole vocabulary is the wake words plus "[unk]", and reads its
 * PARTIAL hypotheses, so there is no number available to threshold. This is
 * the only place left to make the decision.
 *
 * The replacement is a model trained on the phrase with negative training
 * against ambient speech, emitting a calibrated per-frame score tuned to a
 * false-accepts-per-hour target, with VAD gating and a voice-specific verifier
 * behind it. At that point verification is a number and everything below —
 * the stems, the greetings, the edit distance — goes away rather than being
 * maintained. Do not extend it in the meantime; add training data instead.
 *
 * `mentionsInvocation` is a fixed list of mishearings, which is the right
 * shape for deciding whether speech during playback was an interruption — it
 * only has to be right often enough. This one decides whether a turn happens
 * at all, so a miss silently swallows a real request, and it has to tolerate a
 * transcriber writing an uncommon name however it likes.
 *
 * Fuzziness is confined to the opening word. The wake word sits in the
 * pre-roll at the very start of a wake capture, so nothing is given up by
 * refusing to be generous about a word further into a sentence — and being
 * generous there is exactly what would let ordinary room speech back through.
 * "he's the admin on that account" and "just admit you were wrong" both reach
 * the mirror from a kitchen, and neither is addressed to it.
 */
export function addressesEdmund(transcript: string): boolean {
  if (NAME_ANYWHERE.test(transcript)) return true;
  let tokens = transcript
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (tokens[0] !== undefined && GREETINGS.has(tokens[0])) tokens = tokens.slice(1);
  const [first, second] = tokens;
  if (first === undefined) return false;
  if (LEADING_ONLY.has(first) || nearInvocation(first)) return true;
  // Recognizers split the name as often as they run it together, and the Pi's
  // own wake list already carries "ed mund" for that reason.
  return second !== undefined && nearInvocation(first + second);
}

/**
 * The one thing allowed in front of the name, matching the single optional
 * prefix `stripInvocation` already tolerates.
 */
const GREETINGS = new Set(["hey", "hi", "hello", "ok", "okay", "yo", "um", "uh"]);

/**
 * Spellings unambiguous enough to count anywhere in a line, so that "that's
 * enough, Edmund" is an address. `mentionsInvocation` also carries "admit",
 * which is right for its job — mistaking his own bleed for an interruption
 * costs nothing — and wrong for this one, where "just admit you were wrong"
 * would open a turn from across the kitchen.
 */
const NAME_ANYWHERE = /\b(edmund|edmond|edmunds|edman|admund)\b/i;

/**
 * Real words that are also observed mishearings. Only ever the opening of a
 * capture, where the wake word actually is; elsewhere they are just English.
 */
const LEADING_ONLY = new Set(["admit"]);

/**
 * How the name comes back from a transcriber, as sound rather than spelling.
 *
 * The budget is keyed to the STEM, not to the token: one edit on a five-letter
 * stem, two on a six. A flat two would take "human" and "woman" for "edman".
 */
const INVOCATION_STEMS = ["edmund", "edmond", "admund", "edman"];

function nearInvocation(token: string): boolean {
  if (token.length < 4) return false;
  return INVOCATION_STEMS.some((stem) => editDistance(token, stem) <= (stem.length >= 6 ? 2 : 1));
}

/** Levenshtein, one row plus a carried diagonal. Both operands are one word. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0;
      const left = row[j - 1] ?? 0;
      row[j] = Math.min(above + 1, left + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = above;
    }
  }
  return row[b.length] ?? 0;
}

export function stripInvocation(transcript: string): string {
  return transcript
    .replace(
      /^[^a-z0-9]*(hey|ok|okay|hi|yo)?[\s,]*(edmund|edmond|edman|admund|admit)[.,!?\s]*/i,
      "",
    )
    .trim();
}

const CONVERSATION_EXITS = new Set([
  "all done",
  "bye",
  "bye bye",
  "bye for now",
  "catch you later",
  "done",
  "done for now",
  "end conversation",
  "end listening",
  "end the conversation",
  "good bye",
  "good bye for now",
  "good night",
  "goodbye",
  "goodbye for now",
  "im done",
  "never mind",
  "nevermind",
  "no thank you",
  "no thanks",
  "see you later",
  "see ya",
  "talk to you later",
  "thank you",
  "thank you for now",
  "thanks",
  "thanks for now",
  "that is all",
  "that is all for now",
  "that is it",
  "that is it for now",
  "that will be all",
  "thats all",
  "thats all for now",
  "thats it",
  "thats it for now",
  "thatll be all",
  "we are done",
  "we are all done",
  "were done",
  "were all done",
  "you can stop listening",
]);

const HARD_STOPS = new Set([
  "cancel",
  "cancel that",
  "kill it",
  "stop",
  "stop now",
  "stop working",
]);

export function conversationIntent(transcript: string): "bye" | "stop" | "message" {
  const normalized = transcript
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(?:ok|okay|alright|all right|well|please)\s+/, "")
    .replace(/\s+(?:please\s+)?(?:edmund|edmond|edman|admund)$/, "")
    .replace(/\s+please$/, "")
    .trim();
  if (HARD_STOPS.has(normalized)) return "stop";
  if (CONVERSATION_EXITS.has(normalized)) return "bye";
  return "message";
}
