/**
 * Leak check for text that leaves the conversation it came from.
 *
 * This is NOT the consent gate — consent (consent.ts) asks a person whether
 * they want to use someone else's skill. This asks a different question: does
 * the text itself carry something that belonged to one conversation? It
 * guards three outbound surfaces:
 *
 *   • curated skills — distilled from many people's chats and published to
 *     everyone. Nobody in those chats agreed to that, because a distillation
 *     is supposed to be about the SHAPE of a request, not its contents.
 *   • published skills — the author consents for themselves; their chat is
 *     full of other people who did not.
 *   • announcements — written by hand at a moment when the author is thinking
 *     about the feature, not about privacy.
 *
 * Two design commitments
 * ----------------------
 * **The roster has to be the real one.** An earlier version iterated only
 * `[[contacts]]` from config.toml — one entry in this deployment — so the
 * contact-name check ran over a single person and reported clean on text that
 * plainly named others. A scanner that iterates the wrong collection passes
 * everything and looks like it works. Names now come from four sources at
 * once: config contacts, the macOS address book, every person file and every
 * group file. The person files matter most — the address book here holds 34
 * people while the harness knows 81.
 *
 * **Every ambiguity resolves toward flagging.** A false positive costs the
 * author one reword; a false negative ships someone's name to strangers. So
 * an unrecognised word is treated as a name, and the capitalisation rule
 * below only ever RELAXES matching for words that are demonstrably ordinary
 * English — which means an incomplete stoplist makes this stricter, never
 * laxer.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ContactBook } from "../sessions/contacts.ts";

export type LeakFinding = { kind: string; detail: string };

/** Digits that could be a phone number, in the shapes people actually type. */
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
/** "@someone" — a social handle identifies a person without needing a domain. */
const AT_HANDLE_RE = /(?<![\w@])@[a-z0-9_.]{2,30}\b/gi;
/** "910 N 27th St", "42 Oak Avenue" — same shape the Maps card path keys on. */
const STREET_RE =
  /\b\d{1,6}\s+(?:[NSEW]\.?|North|South|East|West)?\s*[A-Za-z0-9'.-]+(?:\s+[A-Za-z0-9'.-]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way|Pl|Place|Ter|Terrace|Cir|Circle|Hwy|Highway)\b\.?/gi;

/**
 * Shortest name token worth checking.
 *
 * Three, not four: the previous cutoff silently exempted Jon, Ana, Ben, Amy,
 * Joe, Kim and every other three-letter name. Two-letter tokens are dropped
 * because initials collide with far too much ordinary text.
 */
const MIN_NAME_LEN = 3;

/**
 * Name tokens that are also ordinary English words.
 *
 * These are the only tokens given a weaker rule: they match only when they
 * appear Capitalised, because "a hunter", "the grace period" and "max offers"
 * are not people while "Hunter", "Grace" and "Max" probably are. Every other
 * name token matches case-insensitively, so lowercase chat text still trips.
 *
 * Being incomplete is safe by construction — a name-word missing from here is
 * matched case-insensitively instead, which flags MORE, not less.
 */
const AMBIGUOUS_NAME_WORDS = new Set([
  "amber",
  "art",
  "autumn",
  "bill",
  "bran",
  "brook",
  "brooke",
  "buck",
  "chase",
  "cliff",
  "colt",
  "dale",
  "dawn",
  "dean",
  "don",
  "dot",
  "drew",
  "earl",
  "faith",
  "field",
  "flint",
  "fox",
  "frank",
  "gene",
  "grace",
  "grant",
  "guy",
  "harmony",
  "hope",
  "hunter",
  "ivy",
  "jade",
  "jet",
  "joy",
  "june",
  "lane",
  "mark",
  "max",
  "may",
  "mercy",
  "miles",
  "moss",
  "olive",
  "page",
  "paige",
  "pat",
  "patience",
  "pearl",
  "penny",
  "price",
  "ray",
  "reed",
  "rich",
  "river",
  "rob",
  "rose",
  "ruby",
  "rusty",
  "sage",
  "sky",
  "sonny",
  "summer",
  "sunny",
  "ted",
  "van",
  "wade",
  "will",
  "wren",
]);

/** Strip diacritics so "José" and "Jose" are the same token. */
function fold(s: string): string {
  // \p{Mn} is every nonspacing combining mark, which is exactly what NFD
  // decomposition leaves behind. A literal range of those marks is the same
  // thing written unclearly, and lints as such.
  return s.normalize("NFD").replace(/\p{Mn}/gu, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every name this deployment could leak, from all four sources.
 *
 * `personaDir` is optional so tests run without a persona tree, but passing
 * it is what makes the check cover the people Edmund actually talks to rather
 * than only the ones written into config.
 */
export function collectKnownNames(contacts: ContactBook, personaDir?: string): string[] {
  const names = new Set<string>(contacts.allKnownNames());
  if (!personaDir) return [...names];
  const dir = join(personaDir, "people");
  if (!existsSync(dir)) return [...names];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const head = readFileSync(join(dir, file), "utf8").slice(0, 400);
      const title = head.match(/^#\s+(.+)$/m)?.[1]?.trim();
      // A file titled with a bare handle carries no name to protect, and the
      // phone/email detectors already cover the handle itself.
      if (title && !/^[+\d]/.test(title) && !title.includes("@")) names.add(title);
    } catch {
      // An unreadable profile is not a reason to fail the scan open; the
      // other sources still apply.
    }
  }
  return [...names];
}

/**
 * Tokens that are never worth flagging, whatever roster they arrive in.
 *
 * A contact card can be titled "Mom", a person file can be headed with a role
 * rather than a name, and neither identifies anyone to a stranger. Kept short
 * on purpose: everything here is a hole in the check, so it holds only tokens
 * that carry no identity at all.
 */
const NEVER_A_NAME = new Set([
  "the",
  "and",
  "for",
  "chat",
  "group",
  "team",
  "home",
  "work",
  "house",
  "family",
  "mom",
  "dad",
  "mum",
  "sis",
  "bro",
  "sister",
  "brother",
  "mother",
  "father",
  "wife",
  "husband",
  "boss",
  "doc",
  "dr",
  "new",
  "old",
  "one",
  "two",
]);

/**
 * Scan text for anything that identifies a specific person.
 *
 * `allowNames` is the author's own names and handles — a person's own skill
 * may say it is theirs. Everyone else may not appear.
 */
export function findLeaks(
  text: string,
  contacts: ContactBook,
  allowNames: string[] = [],
  opts: { personaDir?: string } = {},
): LeakFinding[] {
  const findings: LeakFinding[] = [];
  const allowed = new Set(allowNames.map((n) => fold(n).toLowerCase().trim()).filter(Boolean));

  for (const m of text.matchAll(EMAIL_RE)) {
    if (!allowed.has(m[0].toLowerCase())) findings.push({ kind: "email", detail: m[0] });
  }
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, "");
    // A year range or an ID number is not a phone number; require the 10/11
    // digit shape rather than any run of digits.
    if (digits.length !== 10 && digits.length !== 11) continue;
    if (!allowed.has(m[0].toLowerCase())) findings.push({ kind: "phone", detail: m[0] });
  }
  for (const m of text.matchAll(AT_HANDLE_RE)) {
    if (!allowed.has(m[0].toLowerCase())) findings.push({ kind: "handle", detail: m[0] });
  }
  for (const m of text.matchAll(STREET_RE)) {
    findings.push({ kind: "address", detail: m[0].trim() });
  }

  // A known handle written in some format the phone regex does not recognise
  // still identifies someone. Checked as a literal.
  for (const handle of contacts.allKnownHandles()) {
    if (handle.length >= 7 && text.includes(handle) && !allowed.has(handle.toLowerCase())) {
      findings.push({ kind: "handle", detail: handle });
    }
  }

  const folded = fold(text);
  const lower = folded.toLowerCase();
  const seen = new Set<string>();
  for (const name of collectKnownNames(contacts, opts.personaDir)) {
    for (const part of fold(name).split(/\s+/)) {
      const token = part.trim().replace(/[^A-Za-z'-]/g, "");
      if (token.length < MIN_NAME_LEN) continue;
      const key = token.toLowerCase();
      if (allowed.has(key) || seen.has(key) || NEVER_A_NAME.has(key)) continue;

      // Word boundaries either side: "Kayla" must not match inside
      // "kaylakit", and a skill about marathons must not trip on "Mara".
      // A trailing apostrophe-s is the same name, and \b already allows it.
      const hit = AMBIGUOUS_NAME_WORDS.has(key)
        ? new RegExp(
            `\\b${escapeRe(token[0]!.toUpperCase() + token.slice(1).toLowerCase())}\\b`,
          ).test(folded)
        : new RegExp(`\\b${escapeRe(key)}\\b`).test(lower);
      if (hit) {
        seen.add(key);
        findings.push({ kind: "contact-name", detail: token });
      }
    }
  }

  return findings;
}

/** One line naming what was found, for a refusal message. */
export function describeLeaks(findings: LeakFinding[]): string {
  const shown = findings.slice(0, 4).map((f) => `${f.kind} "${f.detail}"`);
  const more = findings.length > shown.length ? ` (+${findings.length - shown.length} more)` : "";
  return shown.join(", ") + more;
}
