import { existsSync, readFileSync } from "node:fs";
import { personFilePath } from "../claude/persona.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";
import { easternDate } from "../util/clock.ts";
import { ensurePersonFile } from "./ensure.ts";

/**
 * Append a dated note to one of the standard sections in a person file.
 * Creates the file (scaffold) if it doesn't exist. Creates the section
 * (under the appropriate heading) if missing.
 *
 * Sections are the same five the scaffold uses. `"what-ive-learned"` is the
 * default — that's the bucket for preferences, quirks, and facts that
 * modulate future conversations.
 */
export type PersonSection =
  | "who-they-are"
  | "our-dynamic"
  | "what-ive-learned"
  | "shared-history"
  | "open-items";

const SECTION_HEADINGS: Record<PersonSection, string> = {
  "who-they-are": "## Who They Are",
  "our-dynamic": "## Our Dynamic",
  "what-ive-learned": "## What I've Learned",
  "shared-history": "## Shared History",
  "open-items": "## Open Items",
};

export function appendPersonNote(params: {
  handle: string;
  displayName: string | null;
  section: PersonSection;
  note: string;
}): string {
  ensurePersonFile(params.handle, params.displayName);
  const path = personFilePath(params.handle);
  const heading = SECTION_HEADINGS[params.section];
  const today = easternDate();
  const trimmed = params.note.trim();
  const entry = `- **${today}** — ${trimmed}`;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  // Exact-text dedup within the target section — the same guard groups
  // (groups.ts) and self-notes (self-memory.ts) always had. Without it,
  // the maintainer's prompt claimed "the append path is de-duped" while
  // DM person files alone accepted repeats.
  if (sectionContains(current, heading, trimmed)) {
    return path;
  }
  const next = insertUnderHeading(current, heading, entry);
  atomicWriteFileSync(path, next);
  return path;
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

/**
 * Append `line` under `heading`. If the heading is missing, append it at the
 * end. If it exists, insert `line` at the end of that section (right before
 * the next heading or end-of-file).
 */
function insertUnderHeading(doc: string, heading: string, line: string): string {
  const lines = doc.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) {
    const suffix = doc.endsWith("\n") ? "" : "\n";
    return `${doc}${suffix}\n${heading}\n\n${line}\n`;
  }
  // Find the next heading at the same level (## ) after the current one.
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  // Rewind past trailing blanks so we insert just before them.
  let insertAt = end;
  while (insertAt - 1 > headingIdx && lines[insertAt - 1]!.trim() === "") insertAt--;
  // If the section body still only has the placeholder "_(...)_", replace it.
  const bodySlice = lines
    .slice(headingIdx + 1, insertAt)
    .join("\n")
    .trim();
  if (bodySlice.startsWith("_(") && bodySlice.endsWith(")_")) {
    const before = lines.slice(0, headingIdx + 1);
    const after = lines.slice(insertAt);
    return [...before, "", line, "", ...after].join("\n");
  }
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, line, ...after].join("\n");
}
