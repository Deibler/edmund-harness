/**
 * Structure-aware chunking for the recall index.
 *
 * Evidence base (docs/research/memory-architecture-2026-07-28.md):
 *   - 200–400 token (~800–1,600 char) chunks retrieve best; hard cap
 *     ~2,000 chars. Fixed-cap structural splitting matches or beats
 *     embedding-based "semantic" chunking on natural documents.
 *   - Zero overlap when splits land on structural boundaries (headings,
 *     bullets, paragraphs) — overlap mostly buys precision loss.
 *   - Every chunk carries a breadcrumb header (`Doc > Section`) in the
 *     embedded text AND the BM25 index — the free static version of
 *     contextual retrieval.
 *   - Never split a dated bullet: a bullet is one timestamped fact.
 */

export type DocChunk = {
  seq: number;
  /** Chunk text WITH the breadcrumb header as its first line. */
  text: string;
};

const TARGET_CHARS = 1_400;
const HARD_CAP_CHARS = 2_000;
/** Sections with less content than this carry no retrieval signal
 *  (empty scaffolds, lone "(nothing yet)" lines) — skipped. */
const MIN_CONTENT_CHARS = 40;

/**
 * Chunk a markdown document by H2 sections, sub-splitting oversized
 * sections at line boundaries (bullets stay whole). `title` becomes the
 * breadcrumb root — pass the person's display name or the file's slug.
 */
export function chunkMarkdownDoc(title: string, body: string): DocChunk[] {
  const chunks: DocChunk[] = [];
  let seq = 0;

  for (const section of splitSections(body)) {
    const breadcrumb = section.heading === null ? title : `${title} > ${section.heading}`;
    const content = section.lines.join("\n").trim();
    if (content.length < MIN_CONTENT_CHARS) continue;

    for (const piece of packLines(section.lines, TARGET_CHARS, HARD_CAP_CHARS)) {
      chunks.push({ seq, text: `${breadcrumb}\n${piece}` });
      seq++;
    }
  }
  return chunks;
}

/**
 * Chunk plain text (sandbox artifacts) at paragraph/line boundaries.
 * `title` (usually the relative path) heads every chunk.
 */
export function chunkPlainText(title: string, body: string): DocChunk[] {
  const lines = body.split("\n");
  const chunks: DocChunk[] = [];
  let seq = 0;
  for (const piece of packLines(lines, TARGET_CHARS, HARD_CAP_CHARS)) {
    if (piece.trim().length < MIN_CONTENT_CHARS && seq > 0) continue;
    chunks.push({ seq, text: `${title}\n${piece}` });
    seq++;
  }
  if (chunks.length === 0 && body.trim().length > 0) {
    chunks.push({ seq: 0, text: `${title}\n${body.trim().slice(0, HARD_CAP_CHARS)}` });
  }
  return chunks;
}

type Section = { heading: string | null; lines: string[] };

/** Split on `## ` headings; content before the first H2 (H1 line, contact
 *  bullets) forms the preamble section with heading null. */
function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: null, lines: [] };
  for (const line of body.split("\n")) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      sections.push(current);
      current = { heading: m[1]!, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

/**
 * Greedily pack lines into pieces of ~target chars, never splitting a
 * line (bullets and their dates stay whole). A single line longer than
 * the hard cap is truncated — pathological, not worth splitting mid-fact.
 */
function packLines(lines: string[], target: number, hardCap: number): string[] {
  const pieces: string[] = [];
  let buf: string[] = [];
  let size = 0;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.length > 0) pieces.push(text);
    buf = [];
    size = 0;
  };
  for (const raw of lines) {
    const line = raw.length > hardCap ? raw.slice(0, hardCap) : raw;
    if (size > 0 && size + line.length + 1 > target) flush();
    buf.push(line);
    size += line.length + 1;
  }
  flush();
  return pieces;
}
