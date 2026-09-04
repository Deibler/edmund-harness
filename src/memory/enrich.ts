/**
 * Build the text the embedder actually sees for a message — message
 * body plus any attachment metadata the indexer can pull out of chat.db
 * (filename, mime type, Apple's on-device audio transcript).
 *
 * This is the SAME string that ends up in `IndexRow.text`, so when
 * `semantic_search` surfaces a hit, the preview shows the user what
 * matched (e.g. "the voice memo about pickup time" rather than an
 * unhelpful "[image]").
 *
 * Pure function — kept separate from the indexer's chat.db plumbing
 * so it's easy to unit-test.
 */

import { basename } from "node:path";

export type AttachmentInfo = {
  filename: string | null;
  mimeType: string | null;
  /** Pre-extracted Apple on-device transcript for audio attachments. */
  transcript?: string | null;
};

export type EnrichInput = {
  /** Decoded message text (may be empty if attachment-only). */
  text: string;
  attachments: AttachmentInfo[];
};

const IMG_RE = /^image\//i;
const VID_RE = /^video\//i;
const AUD_RE = /^audio\//i;

/**
 * Concatenate message text + a compact metadata block per attachment.
 * Returns the full embed-ready string. Trims and collapses repeated
 * whitespace so identical metadata doesn't push useful tokens out of
 * the model's window.
 */
export function buildEnrichedText(input: EnrichInput): string {
  const parts: string[] = [];
  const text = (input.text ?? "").trim();
  if (text) parts.push(text);

  for (const a of input.attachments) {
    const seg = describeAttachment(a);
    if (seg) parts.push(seg);
  }

  return parts
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function describeAttachment(a: AttachmentInfo): string | null {
  const name = a.filename ? basename(a.filename) : null;
  const mime = a.mimeType ?? "";
  const transcript = (a.transcript ?? "").trim();

  if (AUD_RE.test(mime)) {
    if (transcript) return `[voice memo: ${transcript}]`;
    return name ? `[voice memo: ${name}]` : `[voice memo]`;
  }
  if (IMG_RE.test(mime)) {
    return name ? `[image: ${name}]` : `[image]`;
  }
  if (VID_RE.test(mime)) {
    return name ? `[video: ${name}]` : `[video]`;
  }
  if (mime && name) return `[file ${mime}: ${name}]`;
  if (name) return `[file: ${name}]`;
  return null;
}
