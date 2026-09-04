/**
 * SMS segmentation — how many billed parts a body costs, and how to split a
 * reply so it never silently becomes an expensive multipart message.
 *
 * Two encodings are in play and the difference is not cosmetic:
 *
 *  - **GSM-7**: the classic 7-bit alphabet. 160 characters in a lone message,
 *    153 per part once concatenated (the UDH header eats 7).
 *  - **UCS-2**: used the moment ONE character falls outside GSM-7. 70
 *    characters alone, 67 concatenated.
 *
 * That cliff is the thing to respect. A single curly apostrophe — the kind a
 * model produces without being asked — drops a 160-character reply from one
 * segment to three, and every segment is billed and separately filterable.
 * `markdownToPlaintext` upstream does not normalize punctuation, so this
 * module both measures the cost and offers `toGsm7` to avoid paying it.
 *
 * Seven GSM-7 characters are "extended" and cost TWO septets each
 * (`^{}\[~]|€`). A body of 160 carets is two segments, not one, and code that
 * counts `.length` gets that wrong every time.
 */

/** Basic GSM 03.38 alphabet — one septet each. */
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
/** Extended set — reached via ESC, so each costs two septets. */
const GSM7_EXTENDED = "^{}\\[~]|€";

const BASIC = new Set(GSM7_BASIC);
const EXTENDED = new Set(GSM7_EXTENDED);

export const GSM7_SINGLE = 160;
export const GSM7_CONCAT = 153;
export const UCS2_SINGLE = 70;
export const UCS2_CONCAT = 67;

export type Encoding = "GSM-7" | "UCS-2";

/** True when every character is representable in GSM-7. */
export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!BASIC.has(ch) && !EXTENDED.has(ch)) return false;
  }
  return true;
}

export function encodingFor(text: string): Encoding {
  return isGsm7(text) ? "GSM-7" : "UCS-2";
}

/**
 * Billable length in code units: septets for GSM-7 (extended chars count 2),
 * UTF-16 code units for UCS-2 (so an emoji outside the BMP counts 2).
 */
export function billableLength(text: string): number {
  if (!isGsm7(text))
    return [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  let n = 0;
  for (const ch of text) n += EXTENDED.has(ch) ? 2 : 1;
  return n;
}

/** How many SMS segments this body costs as sent. */
export function segmentCount(text: string): number {
  if (text.length === 0) return 0;
  const gsm = isGsm7(text);
  const len = billableLength(text);
  const single = gsm ? GSM7_SINGLE : UCS2_SINGLE;
  const concat = gsm ? GSM7_CONCAT : UCS2_CONCAT;
  if (len <= single) return 1;
  return Math.ceil(len / concat);
}

/**
 * Replace common non-GSM-7 punctuation with GSM-7 equivalents.
 *
 * Deliberately conservative: only characters whose replacement changes
 * nothing a reader would notice. Anything genuinely non-Latin (an emoji, a
 * name in another script) is left alone and correctly pushes the body to
 * UCS-2 — mangling someone's name to save a segment would be a bad trade.
 */
export function toGsm7(text: string): string {
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ | | | /g, " ")
    .replace(/•/g, "*")
    .replace(/·/g, ".")
    .replace(/™/g, "TM")
    .replace(/®/g, "(R)")
    .replace(/→/g, "->");
}

/**
 * Split a reply into bodies that each fit `maxSegments`.
 *
 * Splits on paragraph, then sentence, then word, and only mid-word as a last
 * resort — a hard cut through a URL is worse than an extra segment, because a
 * broken link is useless AND still billed.
 *
 * Returns at most `maxParts` bodies; anything beyond that is dropped rather
 * than sent, and the caller is expected to notice. Silently texting someone
 * fourteen parts is a worse failure than truncating.
 */
export function chunkForSms(
  text: string,
  opts: { maxSegments?: number; maxParts?: number } = {},
): string[] {
  const maxSegments = Math.max(1, opts.maxSegments ?? 3);
  const maxParts = Math.max(1, opts.maxParts ?? 4);
  const body = text.trim();
  if (!body) return [];

  const gsm = isGsm7(body);
  const concat = gsm ? GSM7_CONCAT : UCS2_CONCAT;
  const single = gsm ? GSM7_SINGLE : UCS2_SINGLE;
  // Budget per chunk: one segment stays under the single-part limit; more
  // than one uses the concatenated size, since a multipart body pays the UDH.
  const budget = maxSegments === 1 ? single : concat * maxSegments;

  if (billableLength(body) <= budget) return [body];

  const out: string[] = [];
  let rest = body;
  while (rest.length > 0 && out.length < maxParts) {
    if (billableLength(rest) <= budget) {
      out.push(rest);
      break;
    }
    const cut = findCut(rest, budget);
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return out.filter((s) => s.length > 0);
}

/**
 * Largest cut index whose prefix fits the budget, preferring a clean boundary.
 *
 * `billableLength` is not the same as `.length` once extended GSM-7 characters
 * or astral emoji are involved, so the ceiling is found by measuring rather
 * than by slicing at the budget and hoping.
 */
function findCut(text: string, budget: number): number {
  let hi = Math.min(text.length, budget);
  while (hi > 0 && billableLength(text.slice(0, hi)) > budget) hi--;
  if (hi <= 0) return Math.max(1, Math.min(text.length, budget));

  const window = text.slice(0, hi);
  for (const re of [/\n\n/g, /(?<=[.!?])\s(?=\S)/g, /\s(?=\S)/g]) {
    const idx = lastMatchIndex(window, re);
    // Only honor a boundary that keeps at least half the budget, or a long
    // reply with no early break would emit a stream of tiny messages.
    if (idx !== null && idx > hi * 0.5) return idx;
  }
  return hi;
}

function lastMatchIndex(s: string, re: RegExp): number | null {
  let last: number | null = null;
  if (re.global) {
    for (const m of s.matchAll(re)) last = m.index! + m[0].length;
    return last;
  }
  const m = s.match(re);
  return m?.index !== undefined ? m.index + m[0].length : null;
}
