/**
 * Strip internal scaffolding from Claude's final reply before it hits iMessage.
 * Normally `claude -p` stream-json gives clean text, but the model occasionally
 * emits thinking blocks, role markers, or memory annotations — especially when
 * it misinterprets system-prompt instructions.
 */
const STRIP_TAGS = [
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<scratchpad>[\s\S]*?<\/scratchpad>/gi,
  /<relevant_memories>[\s\S]*?<\/relevant_memories>/gi,
  /<final>|<\/final>/gi,
];

const ROLE_LINE = /^(system|assistant|user)\s*:\s*/gim;
const INTERNAL_SEP = /^###\+#.*$/gm;

export function sanitizeOutbound(text: string): string {
  // KEEP_QUIET is the model's explicit veto sentinel. The persona promises
  // it works in EVERY venue (see persona/VENUE_DM.md, VENUE_GROUP.md) — reply
  // with exactly `KEEP_QUIET` and the harness drops the output silently. It's
  // checked here, before any other processing, so the veto is honored on every
  // path that goes through deliverReply (channels turn, recovery, cron fire,
  // the send_message tool) — not just the proactive fire path that had its own
  // inline check. Without this, a veto on a normal inbound turn shipped the
  // literal string "KEEP_QUIET" to the chat.
  if (isKeepQuiet(text)) return "";
  let out = text;
  for (const re of STRIP_TAGS) out = out.replace(re, "");
  out = out.replace(ROLE_LINE, "");
  out = out.replace(INTERNAL_SEP, "");
  out = stripAITypography(out);
  // Collapse runs of blank lines.
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  if (looksLikeIntentionalSilence(out)) return "";
  return out;
}

/**
 * True when the reply is solely the `KEEP_QUIET` veto sentinel. Matches the
 * exact, anchored shape the persona instructs the model to emit ("exactly
 * `KEEP_QUIET`, no punctuation, no other words"): the whole reply is the
 * token, case-insensitive, ignoring surrounding whitespace. Deliberately
 * strict so a real message that merely mentions KEEP_QUIET is never eaten.
 * Mirrors the regex in proactive/fire.ts.
 */
export function isKeepQuiet(text: string): boolean {
  return /^\s*KEEP_QUIET\s*$/i.test(text);
}

/**
 * The model sometimes responds to a "no-op" wake-up (a poke firing after the
 * work already finished, a duplicate cron, etc.) by producing a short reply
 * that *describes* its intent to stay silent — "Silent, nothing owed",
 * "(no response needed)", "Staying quiet on this one." Whatever the
 * reasoning, the harness will dutifully send that text to the user, who
 * sees a string of bot-shaped meta-replies stack up in the thread (the
 * exact failure mode that prompted this filter).
 *
 * Real silence is an EMPTY assistant message — the runner already treats an
 * empty reply as a tool-only turn and skips delivery. This filter is the
 * backstop: if the whole reply is short and reads as a silence-intent
 * statement rather than a real message, drop it.
 *
 * Bias is toward false negatives: only catch patterns that wouldn't appear
 * inside a real reply. We require both a short total length (<140 chars)
 * AND the silence marker to be the leading content, so a normal sentence
 * that happens to mention "no response needed" mid-text won't be eaten.
 */
export function looksLikeIntentionalSilence(text: string): boolean {
  const stripped = text.replace(/^[\s.,!?()[\]"'*_-]+/, "").toLowerCase();
  if (stripped.length === 0) return true;
  if (text.length > 140) return false;

  // Patterns the model has actually emitted in production thread leaks.
  // Add new ones here as they show up — keep them anchored to the start so
  // they only match silence-statements, not in-line phrasing.
  //
  // Defensive backstop. The persona now tells the model to always reply
  // when invoked (the harness has already decided invocation = response),
  // so these phrases shouldn't appear in normal output. But model drift
  // happens, and the failure mode — bot-narrating-itself shipped to a
  // group thread — is one of the worst AI tells. Keep dropping them.
  const SILENCE_OPENERS = [
    /^silent\b/,
    /^silence\b/,
    /^no (response|reply|action) needed/,
    /^no (response|reply)\b/,
    /^nothing (to add|owed|needed)/,
    /^already (handled|delivered|sent), no/,
    /^lurking\b/,
    /^standing down\b/,
    /^staying (out|quiet)\b/,
    /^not addressed to me\b/,
    /^group chat,? not addressed/,
  ];
  return SILENCE_OPENERS.some((re) => re.test(stripped));
}

/**
 * Replace typography patterns that flag a reply as AI-written and hurt
 * iMessage-bubble readability. The persona already bans these, but the
 * backstop runs on every outbound so drift from a single turn doesn't
 * leak into the user's thread.
 *
 * - Em-dash (—, U+2014): convert to " - " surrounded by one space on each
 *   side if it was being used as a pause. Strip the surrounding whitespace
 *   afterward to avoid double-spaces.
 * - En-dash (–, U+2013) inside words stays (used in ranges like "9–5"), but
 *   as a prose pause becomes " - ".
 * - Smart quotes (“ ” ‘ ’) → ASCII.
 * - Horizontal ellipsis (…) → "..." (three ASCII dots).
 * - Non-breaking space (U+00A0) → regular space.
 */
export function stripAITypography(text: string): string {
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/(\s)–(\s)/g, "$1-$2")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/ {2,}/g, " ");
}

/**
 * iMessage doesn't render Markdown. Convert the common formatting to
 * plaintext so replies don't show `**bold**` literally.
 */
export function markdownToPlaintext(text: string): string {
  let out = text;
  // Preserve fenced code blocks verbatim.
  const fences: string[] = [];
  out = out.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });
  // Headers: "## foo" → "foo"
  out = out.replace(/^#{1,6}\s+/gm, "");
  // Bold/italic/strike — strip markers, keep text.
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/~~([^~]+)~~/g, "$1");
  // Inline code → keep content without backticks.
  out = out.replace(/`([^`\n]+)`/g, "$1");
  // Links: [text](url) → "text (url)"
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  // iMessage is plaintext — decode any HTML entities that slipped in (the model
  // sometimes emits "&gt;30" when writing about inequalities/comparisons; nothing
  // downstream un-escapes them, so recipients saw the literal entity). Decode the
  // common ones so they render as real characters. "&amp;" is decoded LAST so a
  // literal "&amp;gt;" (meaning the text "&gt;") doesn't get over-decoded to ">".
  out = out
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  // List bullets: "- " stays (readable in iMessage).
  // Restore fences.
  out = out.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => fences[Number.parseInt(i, 10)] ?? "");
  return out;
}
