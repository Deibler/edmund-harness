/**
 * Turning a reply into speech-sized text: shared by every channel that speaks
 * (the mirror, FaceTime calls). Moved here unchanged from the mirror's voice
 * module so neither channel has to import the other.
 */

/** Below this, a sentence is not worth its own request and audible seam. */
const MIN_CHUNK_CHARS = 24;
/** Trailing tokens whose period ends an abbreviation, not a sentence. */
const ABBREVIATION_END =
  /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|ave|rd|vs|etc|approx|no|fig|inc|ltd|co|dept|est|min|max|[a-z])\.$/i;

/**
 * Split a reply into utterances that can be synthesized and sent independently.
 *
 * Time-to-first-audio is what a conversation actually feels like, and it is
 * bounded by the FIRST chunk rather than the whole reply — a long answer starts
 * speaking in a few hundred milliseconds instead of a few seconds. The Pi
 * already queues and plays chunks back-to-back, so this needs no protocol
 * change.
 *
 * Splits on sentence ends only. Prosody carries across a comma but not a full
 * stop, so anything finer would be audible as chopped-up speech, and short
 * trailing fragments are merged back for the same reason.
 */
export function speechChunks(text: string, maxChunks = 8): string[] {
  const clean = text.trim();
  if (!clean) return [];
  // Split only at a terminator followed by whitespace and the start of the next
  // sentence — never inside a token. Matching bare [.!?] would cut "82.4" into
  // "82." and "4", which is audible as "eighty two. four degrees." Punctuation
  // stays attached; the synthesizer needs it for falling intonation.
  const sentences = clean.split(/(?<=[.!?]["')\]]*)\s+(?=["'([]*[A-Z0-9])/);
  if (sentences.length === 0) return [clean];

  const chunks: string[] = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const previous = chunks.at(-1);
    // "Dr." / "No." / an initial is a terminator by shape only — rejoin so the
    // sentence is spoken as one breath.
    if (previous !== undefined && ABBREVIATION_END.test(previous)) {
      chunks[chunks.length - 1] = `${previous} ${sentence}`;
      continue;
    }
    // A lone "Sure." or "1998." is too short to be worth its own request and
    // its own audible gap; fold it into its neighbour.
    if (
      previous !== undefined &&
      (sentence.length < MIN_CHUNK_CHARS || previous.length < MIN_CHUNK_CHARS)
    ) {
      chunks[chunks.length - 1] = `${previous} ${sentence}`;
      continue;
    }
    chunks.push(sentence);
  }
  if (chunks.length === 0) return [clean];
  // The screen's audio queue is bounded; past that, pack the remainder into the
  // last chunk rather than dropping any of the reply.
  if (chunks.length > maxChunks) {
    const head = chunks.slice(0, maxChunks - 1);
    head.push(chunks.slice(maxChunks - 1).join(" "));
    return head;
  }
  return chunks;
}

/**
 * Strip markdown and other chat-formatting the TTS would read literally.
 * The mirror reply is SPOKEN — asterisks, backticks, and link syntax all
 * turn into noise on the speaker.
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A sentence end followed by the start of the next one, or a paragraph break. */
const STREAM_BOUNDARY = /[.!?]["')\]]*\s+(?=["'([]*[A-Z0-9])|\n{2,}/g;

/**
 * Take the complete sentences off the front of streaming text.
 *
 * For speech that starts while the model is still writing: a sentence is
 * complete once the next one has visibly begun, so "82.4" and "Dr. Smith" are
 * never cut (the same rules as `speechChunks`). A run past `maxRun` characters
 * with no sentence end is cut at its last comma or space instead, so a long
 * unpunctuated stretch cannot hold speech back indefinitely.
 */
export function takeSentences(buffer: string, maxRun = 240): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (const match of buffer.matchAll(STREAM_BOUNDARY)) {
    const terminatorEnd = match.index + match[0].trimEnd().length;
    const sentence = buffer.slice(start, terminatorEnd).trim();
    if (!sentence) {
      start = match.index + match[0].length;
      continue;
    }
    if (ABBREVIATION_END.test(sentence)) continue;
    sentences.push(sentence);
    start = match.index + match[0].length;
  }
  let rest = buffer.slice(start);
  while (rest.length > maxRun) {
    const window = rest.slice(0, maxRun);
    const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf(" "));
    if (cut <= 0) break;
    sentences.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  return { sentences, rest };
}
