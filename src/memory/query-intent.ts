/**
 * Whether a message is worth searching memory for.
 *
 * Semantic search always returns its quota. Asked for ten hits it returns ten,
 * however little the query had to say, and the ranking is only ever relative to
 * the other candidates — never to whether any of them are actually about
 * anything. A greeting is the worst case: "hi" is mildly similar to everything,
 * so it scores *higher* against the corpus than a specific question does.
 * Measured on this index, "Edmund hi" tops out at 0.761 while "SpaceX stock
 * tracker tunnel" — a query about something genuinely in there — reaches 0.759.
 *
 * No score threshold can separate those two, because the problem is not that
 * the matches are weak. It is that the query has no subject, so every match is
 * spurious by construction. The fix is upstream of scoring: recognise that
 * there is nothing to look up, and don't look.
 *
 * That is what produced the reported failure. A bare "Edmund hi" pulled 28
 * items from one to four months earlier, the strongest of them a six-week-old
 * request about a stock tracker, and the model opened with a status report on it.
 *
 * Deliberately conservative: it only declines when the message is short AND
 * every word in it is a greeting, an acknowledgement, or our own name. Anything
 * with a subject — even a terse one — still searches.
 */

/** Words that carry no subject to search for. */
const EMPTY_WORDS = new Set([
  // greetings
  "hi",
  "hii",
  "hiii",
  "hey",
  "heyy",
  "heyyy",
  "hello",
  "helo",
  "yo",
  "sup",
  "howdy",
  "morning",
  "afternoon",
  "evening",
  "night",
  "gm",
  "gn",
  // acknowledgements and closers
  "thanks",
  "thank",
  "thx",
  "ty",
  "cheers",
  "np",
  "ok",
  "okay",
  "k",
  "kk",
  "yes",
  "yep",
  "yeah",
  "ya",
  "yup",
  "no",
  "nope",
  "nah",
  "sure",
  "cool",
  "nice",
  "great",
  "good",
  "lol",
  "lmao",
  "haha",
  "hah",
  "ha",
  "wow",
  "huh",
  "oh",
  "ah",
  "hmm",
  "hm",
  "yikes",
  "damn",
  "bye",
  "later",
  "welcome",
  // filler that adds no subject
  "u",
  "you",
  "there",
  "again",
  "please",
  "pls",
  "just",
  "so",
  "well",
  "and",
  "but",
  "the",
  "a",
  "an",
  "it",
  "im",
  "i",
  "am",
  "are",
  "is",
]);

/** Longest message we will ever decline to search for, in characters. */
const SHORT_MESSAGE_CHARS = 60;

/**
 * True when the message has something to look up.
 *
 * `names` are the assistant's own trigger words: being addressed is not a
 * subject, so "Edmund hi" is as empty as "hi".
 */
export function hasRetrievableIntent(text: string, names: readonly string[] = []): boolean {
  const trimmed = text.trim();
  // Too short to have said anything. Was the only guard here before, at four
  // characters, which "Edmund hi" clears without having a subject.
  if (trimmed.length < 4) return false;
  // Long messages always search: whatever else is in them, something is.
  if (trimmed.length > SHORT_MESSAGE_CHARS) return true;

  const ownNames = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const words = trimmed
    .toLowerCase()
    // Keep letters, digits and apostrophes; everything else is a separator, so
    // punctuation and emoji cannot masquerade as content.
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);

  if (words.length === 0) return false;

  for (const word of words) {
    if (ownNames.has(word)) continue;
    if (EMPTY_WORDS.has(word)) continue;
    // A number is a subject — "$174", "11 shares", "kdix 88d".
    return true;
  }
  return false;
}
