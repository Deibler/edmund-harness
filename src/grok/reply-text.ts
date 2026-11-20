/**
 * Make an Edmund reply fit a voice: collapse whitespace (a car does not read
 * line breaks) and, past `maxChars`, cut at the last sentence that fits so the
 * answer never ends mid-word. The full text still reaches the log.
 */
export function forVoice(text: string, maxChars: number): string {
  const flat = text
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (flat.length <= maxChars) return flat;
  const window = flat.slice(0, maxChars);
  const lastStop = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
  );
  if (lastStop >= maxChars * 0.4) return window.slice(0, lastStop + 1);
  const lastSpace = window.lastIndexOf(" ");
  return `${window.slice(0, lastSpace > 0 ? lastSpace : maxChars).trimEnd()}…`;
}
