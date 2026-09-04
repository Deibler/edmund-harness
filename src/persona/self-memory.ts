import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONA_DIR } from "../claude/persona.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";
import { easternDate } from "../util/clock.ts";

/**
 * Self-memory file mutations. Mirrors `write-note.ts` (which targets
 * `persona/people/<handle>.md`) but for the persona-level files —
 * `SOUL.md` (the diary of who Edmund is becoming) and `IDENTITY.md`
 * (core stable facts). Without write tools, the model can only read
 * them and they stay frozen at whatever scaffolding shipped.
 *
 * Conservative by design:
 *   - `appendSelfNote` is the cheap path for accreting one-line facts
 *     into a named section. Always writes to SOUL.md (the file with the
 *     explicit evolving-character scaffold). Idempotent across re-runs:
 *     same `note` text under the same section is skipped.
 *   - `writeSelfFile` is the full-rewrite escape hatch (rename sections,
 *     trim dead scaffolding, restructure). Backs up the previous version
 *     as `<file>.md.bak` so a bad edit is one cp away from recovery.
 */

export type SelfSection = "opinions" | "running-bits" | "tastes" | "annoyances" | "other";

export type SelfFile = "SOUL.md" | "IDENTITY.md" | "AGENTS.md";

const SECTION_HEADINGS: Record<SelfSection, string> = {
  opinions: "### Opinions and positions you hold",
  "running-bits": "### Running bits and shorthand",
  tastes: "### Tastes you've developed",
  annoyances: "### Things that annoy you",
  other: "### Other durable context",
};

const SOUL_PATH = join(PERSONA_DIR, "SOUL.md");

/**
 * Longest self-note accepted.
 *
 * The existing entries averaged 940 characters and ran to 2,196 — essays, not
 * facts. 90 of them had grown "Other durable context" to 20.5k tokens: half of
 * the entire system prompt, carried on every turn of every conversation. A
 * durable fact is a line or two; the reasoning that produced it belongs in the
 * conversation, which recall already indexes.
 */
export const MAX_SELF_NOTE_CHARS = 500;

/**
 * Drop a date the model wrote itself.
 *
 * This helper stamps the date, and the model also opens with one, which is how
 * every existing bullet reads `- **2026-08-10** — 2026-08-10 — …`. Harmless
 * but it is duplicated in ~90 entries and reads as a bug in the file.
 */
function stripLeadingDate(note: string): string {
  return note.replace(/^\(?\d{4}-\d{2}-\d{2}\)?\s*[—–-]\s*/, "").trim();
}

/**
 * Append a dated bullet under one of the five evolving-character sections
 * in SOUL.md. Creates the section if it's missing. Idempotent: if a bullet
 * with the same trimmed note text already exists under that section, no-op.
 */
export function appendSelfNote(params: { section: SelfSection; note: string }): {
  path: string;
  appended: boolean;
} {
  const heading = SECTION_HEADINGS[params.section];
  const trimmed = stripLeadingDate(params.note.trim());
  if (!trimmed) throw new Error("note must not be empty");
  if (trimmed.length > MAX_SELF_NOTE_CHARS) {
    // Refused rather than truncated: silently cutting a note loses the half
    // the model thought mattered, and it has already shown it will retry.
    throw new Error(
      `self-note is ${trimmed.length} chars; the cap is ${MAX_SELF_NOTE_CHARS}. ` +
        "SOUL.md is injected into EVERY turn of EVERY conversation, so this " +
        "text is re-read forever — it is the most expensive place to write. " +
        "Keep a durable fact to a line or two. Anything longer belongs in the " +
        "conversation itself, which recall indexes and can search later.",
    );
  }
  const today = easternDate();
  const entry = `- **${today}** — ${trimmed}`;

  const current = existsSync(SOUL_PATH) ? readFileSync(SOUL_PATH, "utf8") : "";
  // Idempotency: if the same body text already appears under this heading,
  // skip. Lets the model retry / restate without producing duplicates.
  if (sectionContains(current, heading, trimmed)) {
    return { path: SOUL_PATH, appended: false };
  }

  const next = insertUnderHeading(current, heading, entry);
  atomicWriteFileSync(SOUL_PATH, next);
  return { path: SOUL_PATH, appended: true };
}

export function readSelfFile(file: SelfFile): string {
  const path = join(PERSONA_DIR, file);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

export function writeSelfFile(
  file: SelfFile,
  body: string,
): { path: string; backupPath: string | null } {
  const path = join(PERSONA_DIR, file);
  const backupPath = `${path}.bak`;
  if (existsSync(path)) {
    copyFileSync(path, backupPath);
  }
  atomicWriteFileSync(path, body.endsWith("\n") ? body : `${body}\n`);
  return { path, backupPath: existsSync(backupPath) ? backupPath : null };
}

function sectionContains(doc: string, heading: string, needle: string): boolean {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ") || lines[i]!.startsWith("### ")) {
      end = i;
      break;
    }
  }
  const block = lines
    .slice(start + 1, end)
    .join("\n")
    .toLowerCase();
  return block.includes(needle.toLowerCase());
}

function insertUnderHeading(doc: string, heading: string, line: string): string {
  const lines = doc.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) {
    const suffix = doc.endsWith("\n") ? "" : "\n";
    return `${doc}${suffix}\n${heading}\n\n${line}\n`;
  }
  // Insert at the end of the section (just before the next ## or ### heading).
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ") || lines[i]!.startsWith("### ")) {
      end = i;
      break;
    }
  }
  // Skip trailing blanks inside the section so the new entry hugs the
  // existing content rather than leaving a gap.
  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}
