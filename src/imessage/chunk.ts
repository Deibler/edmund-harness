/**
 * Split a long reply into iMessage-sized chunks without butchering it.
 *
 * Rules:
 *  1. Never split inside a ``` fenced code block. Keep the fence whole; if
 *     a single fence exceeds the limit, emit it as its own oversize chunk.
 *  2. Prefer paragraph boundaries (`\n\n`), then newlines, then sentences,
 *     then word boundaries. Never mid-word.
 *  3. Emit at most one chunk if the whole message fits.
 */
export function chunkForIMessage(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];
  const blocks = splitByFences(trimmed);
  const chunks: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const block of blocks) {
    if (block.kind === "fence") {
      // Fence is indivisible. Emit current, then the fence (even if oversize).
      if (current) push();
      chunks.push(block.text);
      continue;
    }
    for (const piece of splitProse(block.text, maxChars)) {
      if (current.length + piece.length + 2 > maxChars && current) push();
      current = current ? `${current}\n\n${piece}` : piece;
      if (current.length >= maxChars) push();
    }
  }
  if (current) push();
  return chunks;
}

type Block = { kind: "prose" | "fence"; text: string };

function splitByFences(text: string): Block[] {
  const out: Block[] = [];
  const re = /```[\s\S]*?```/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: "prose", text: text.slice(last, idx) });
    out.push({ kind: "fence", text: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ kind: "prose", text: text.slice(last) });
  return out.filter((b) => b.text.length > 0);
}

function splitProse(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const out: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      out.push(p);
      continue;
    }
    out.push(...splitLongParagraph(p, maxChars));
  }
  return out;
}

function splitLongParagraph(p: string, maxChars: number): string[] {
  // Try sentence boundaries first.
  const sentences = p.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(...splitByWords(s, maxChars));
      continue;
    }
    if (buf.length + s.length + 1 > maxChars) {
      out.push(buf);
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function splitByWords(s: string, maxChars: number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const word of s.split(/\s+/)) {
    if (buf.length + word.length + 1 > maxChars) {
      if (buf) out.push(buf);
      buf = word;
    } else {
      buf = buf ? `${buf} ${word}` : word;
    }
  }
  if (buf) out.push(buf);
  return out;
}
