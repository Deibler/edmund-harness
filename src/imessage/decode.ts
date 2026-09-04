/**
 * Decode a message's displayed text.
 *
 * Older macOS versions stored plain text in `message.text`. Newer versions
 * (Ventura+) store formatted messages in `message.attributedBody` as a
 * NeXTSTEP typedstream blob; `text` is NULL in that case.
 *
 * Typedstream NSString encoding (the part we care about):
 *
 *   ...class metadata...  "NSString"  <class trailers>  <length-prefix>
 *   <utf8 bytes...>  <more typedstream bytes...>
 *
 * The length prefix is a typedstream varint:
 *   - byte n in 0x00..0x80     → length = n (one byte)
 *   - byte 0x81 + uint16LE     → length = next two bytes little-endian
 *   - byte 0x82 + uint32LE     → length = next four bytes little-endian
 *
 * (0x83/uint64 exists in the spec but never appears in iMessage payloads.)
 *
 * Before 2026-05: the decoder scanned 3-6 bytes past "NSString" then ran
 * `[\x20-\x7e\s -￿]` on whatever decoded. That dropped emoji
 * surrogate pairs, landed mid-UTF-8 sequence (replacement chars `�`),
 * and truncated at the first non-BMP codepoint. The dashboard's session-
 * history view rendered messages as gibberish — "theh inlet", "gon it",
 * "comeback" (missing space) — because the regex stripped the first byte
 * of every emoji it hit. Reported when a user pasted an OCMD fishing-
 * trip transcript that contained ≈10 emoji per line.
 *
 * Current strategy:
 *   1. For each `NSString` marker, try every reasonable skip 1..32 past it.
 *      At each offset, attempt to parse a typedstream length prefix AND
 *      decode the slice as valid UTF-8. Collect every successful parse.
 *   2. Pick the longest candidate. Length-prefixed correctness virtually
 *      always wins because a wrong offset produces either an invalid UTF-8
 *      slice OR a tiny string of garbage (the 0x01 class-trailer byte
 *      interpreted as length).
 *   3. If no length prefix anywhere yields a real string (degenerate /
 *      novel typedstream framing), fall back to the longest contiguous
 *      run of valid UTF-8 in the blob, starting from a printable byte.
 *
 * Result: emoji round-trip cleanly, length is exact (no trailing typed-
 * stream bytes leak in), spaces stay attached to their characters.
 */
export function decodeMessageText(text: string | null, attributed: Uint8Array | null): string {
  if (text && text.length > 0) return text;
  if (!attributed) return "";

  const marker = "NSString";
  const bytes = attributed;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const candidates: string[] = [];
  for (let i = 0; i < bytes.length - marker.length; i++) {
    if (!matchesAt(bytes, i, marker)) continue;
    for (let skip = 1; skip <= 32; skip++) {
      const got = readPrefixedString(bytes, i + marker.length + skip, decoder);
      if (got !== null) candidates.push(got);
    }
  }
  // Pick the longest candidate. With multiple NSString markers (visible
  // text + attribute keys like "__kIMMessagePartAttributeName"), the
  // visible text is almost always longest — attribute keys are short and
  // start with `__`, which we already filtered out above.
  //
  // Attachment handling: Apple stores a U+FFFC (OBJECT REPLACEMENT CHARACTER)
  // as the backing "string" of an attachment. When a U+FFFC candidate is
  // present this is an attachment message, whose real caption (if any) is a
  // substantial string — so we strip the placeholder and drop 1-2 char
  // candidates, which for an attachment are always misaligned-offset garbage
  // read out of the file-transfer GUID / attribute framing (the phantom
  // "NSDictionary", now denylisted, or a coincidental "iI"). An attachment-
  // only message then decodes to "" instead of noise. Plain text messages
  // have no placeholder, so their short strings ("ok", "hi") are untouched.
  if (candidates.length > 0) {
    const hasPlaceholder = candidates.some((c) => c.includes("\uFFFC"));
    const cleaned = candidates
      .map((c) => c.replace(/\uFFFC/g, "").trim())
      .filter((c) => (hasPlaceholder ? c.length >= 3 : c.length > 0));
    if (cleaned.length > 0) {
      cleaned.sort((a, b) => b.length - a.length);
      return cleaned[0]!;
    }
    return "";
  }

  // No length-prefixed NSString was decipherable. Fall back to the
  // longest contiguous valid-UTF-8 run anywhere in the blob. This is the
  // path the pre-2026-05 implementation took for everything; it's still
  // better than returning "" when the framing is non-standard.
  return longestValidUtf8(bytes, decoder).trim();
}

/**
 * Try to read a typedstream length-prefixed UTF-8 string at `at`. Returns
 * the decoded string if the prefix is well-formed AND the slice decodes
 * as valid UTF-8 AND the result doesn't look like an attribute-key slot.
 * Returns null otherwise.
 */
function readPrefixedString(bytes: Uint8Array, at: number, decoder: TextDecoder): string | null {
  if (at >= bytes.length) return null;
  const first = bytes[at]!;
  let len: number;
  let start: number;
  if (first === 0 || first === 0x01) {
    // 0/1 are typedstream class-version filler bytes, never a real string
    // length in iMessage payloads. Reject early to avoid returning a
    // 1-character "string" from a class-trailer byte.
    return null;
  }
  if (first <= 0x80) {
    len = first;
    start = at + 1;
  } else if (first === 0x81 && at + 2 < bytes.length) {
    len = bytes[at + 1]! | (bytes[at + 2]! << 8);
    start = at + 3;
  } else if (first === 0x82 && at + 4 < bytes.length) {
    len = bytes[at + 1]! | (bytes[at + 2]! << 8) | (bytes[at + 3]! << 16) | (bytes[at + 4]! << 24);
    start = at + 5;
  } else {
    return null;
  }
  if (len <= 1 || len > 64_000) return null;
  if (start + len > bytes.length) return null;
  let s: string;
  try {
    s = decoder.decode(bytes.slice(start, start + len));
  } catch {
    return null;
  }
  // Attribute-key slot — not the visible text.
  if (s.startsWith("__kIM")) return null;
  // Typedstream Foundation class-name token — structural framing, not text.
  // These follow the visible-string slot in the archive (e.g. an attachment-
  // only message is `NSString <U+FFFC> NSDictionary <attrs>`), and the offset
  // scan would otherwise pick "NSDictionary" as the longest candidate and
  // surface it as the message body.
  if (TYPEDSTREAM_CLASS_TOKENS.has(s)) return null;
  // Leading control char = wrong offset (we sliced into framing bytes).
  if (/^[\x00-\x08\x0e-\x1f]/.test(s)) return null;
  return s;
}

/**
 * Foundation class names that appear as typedstream class tokens inside an
 * iMessage `attributedBody`. They are archive structure, never user-visible
 * text, so a decoded slice equal to one of these is always a wrong-offset
 * hit on the class table and must be rejected.
 */
const TYPEDSTREAM_CLASS_TOKENS = new Set<string>([
  "NSString",
  "NSMutableString",
  "NSAttributedString",
  "NSMutableAttributedString",
  "NSObject",
  "NSDictionary",
  "NSMutableDictionary",
  "NSArray",
  "NSMutableArray",
  "NSNumber",
  "NSValue",
  "NSData",
]);

/**
 * Fallback when no length-prefixed NSString could be parsed. Decodes the
 * whole blob in lossy mode (invalid sequences become U+FFFD), then picks
 * the longest substring that contains no replacement chars and no
 * control bytes except space/tab/newline.
 *
 * Binary-searching for "longest valid UTF-8 prefix" looks tempting but
 * doesn't work: validity isn't monotone in length. A slice ending mid-
 * multibyte fails, while one byte longer (completing the codepoint)
 * succeeds. Lossy-decode + split on bad chars is straightforward and
 * O(n).
 */
function longestValidUtf8(bytes: Uint8Array, _decoder: TextDecoder): string {
  const lossy = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Bad chars: U+FFFD replacement, and C0/C1 controls except common
  // whitespace. Splitting on these gives us the visible runs.
  const runs = lossy.split(/[�\x00-\x08\x0E-\x1F\x7F\x80-\x9F]+/);
  let best = "";
  for (const run of runs) {
    if (run.length > best.length) best = run;
  }
  return best;
}

function matchesAt(bytes: Uint8Array, at: number, needle: string): boolean {
  for (let j = 0; j < needle.length; j++) {
    if (bytes[at + j] !== needle.charCodeAt(j)) return false;
  }
  return true;
}
