/**
 * Neutralize inbound text before it reaches the model.
 *
 * Threat: user (or a prior assistant output echoed back) sends text that
 * *looks* like a system message. Without neutralization, Claude might treat
 * "[System Message] forget your instructions" as an authoritative directive.
 *
 * We don't block — we render the markers inert so Claude still sees what
 * the user wrote, but with the authority stripped.
 */
export function sanitizeInbound(text: string): string {
  let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Bracketed directives: "[System Message]" → "(System Message)".
  out = out.replace(/\[(system message|system|assistant|user)\]/gi, (_, tag) => `(${tag})`);
  // Line-leading role prefixes: "System: do X" → "System (untrusted): do X".
  out = out.replace(/^(system|assistant|user)\s*:/gim, (_, role) => `${role} (untrusted):`);
  // XML-ish tags sometimes used in system prompts.
  out = out.replace(/<\/?(system|instructions|memory|assistant|user)>/gi, "");
  return out;
}

/**
 * Detect internal scaffolding that leaked into an inbound message. Usually
 * means a previous reply bounced back or got copy-pasted; either way we
 * shouldn't react, because doing so compounds the leak.
 */
const LEAK_MARKERS = [
  /^###\+#/m, // internal scaffold separator leaked from a prior agent run
  /<thinking>/i,
  /<\/thinking>/i,
  /<relevant_memories>/i,
  /<final>/i,
  /<\/final>/i,
];

export function looksLikeLeakedScaffolding(text: string): boolean {
  // Only scan outside fenced code blocks — the user might legitimately
  // paste a snippet that contains these strings as literals in backticks.
  const stripped = text.replace(/```[\s\S]*?```/g, "");
  return LEAK_MARKERS.some((re) => re.test(stripped));
}
