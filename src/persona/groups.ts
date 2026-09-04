import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { groupFilePath } from "../claude/persona.ts";
import { atomicWriteFileSync } from "../util/atomic-write.ts";
import { easternDate } from "../util/clock.ts";

/**
 * `persona/groups/<slug>.md` lifecycle. Mirrors `persona/ensure.ts` +
 * `persona/crud.ts` for people, but with sections tuned for groups: who's
 * in the room, the vibe, recurring topics, plans in flight, and dated
 * events. Auto-created on first inbound from a group; updated by the
 * background maintainer (and writable by the model via group-scoped
 * MCP tools).
 *
 * Stable keying: filename is `slugify(chatGuid)`. Group names change as
 * people get added or someone renames the chat; the GUID does not.
 */

export type GroupSection =
  | "whos-in-it"
  | "group-dynamic"
  | "recurring-topics"
  | "open-items"
  | "shared-history";

const SECTION_HEADINGS: Record<GroupSection, string> = {
  "whos-in-it": "## Who's In It",
  "group-dynamic": "## Group Dynamic",
  "recurring-topics": "## Recurring Topics",
  "open-items": "## Open Items",
  "shared-history": "## Shared History",
};

export function ensureGroupFile(chatGuid: string, displayName: string | null): string | null {
  if (!chatGuid) return null;
  const path = groupFilePath(chatGuid);
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, scaffold(chatGuid, displayName));
  console.log(`[persona] created ${path}`);
  return path;
}

export function readGroupFile(chatGuid: string): { path: string; body: string } | null {
  const path = groupFilePath(chatGuid);
  if (!existsSync(path)) return null;
  return { path, body: readFileSync(path, "utf8") };
}

export function writeGroupFile(params: {
  chatGuid: string;
  displayName: string | null;
  body: string;
}): string {
  ensureGroupFile(params.chatGuid, params.displayName);
  const path = groupFilePath(params.chatGuid);
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
    } catch {}
  }
  const trimmed = params.body.trimEnd();
  atomicWriteFileSync(path, `${trimmed}\n`);
  return path;
}

export function appendGroupNote(params: {
  chatGuid: string;
  displayName: string | null;
  section: GroupSection;
  note: string;
}): { path: string; appended: boolean } {
  ensureGroupFile(params.chatGuid, params.displayName);
  const path = groupFilePath(params.chatGuid);
  const heading = SECTION_HEADINGS[params.section];
  const trimmed = params.note.trim();
  if (!trimmed) throw new Error("note must not be empty");
  const today = easternDate();
  const entry = `- **${today}** — ${trimmed}`;

  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (sectionContains(current, heading, trimmed)) {
    return { path, appended: false };
  }
  const next = insertUnderHeading(current, heading, entry);
  atomicWriteFileSync(path, next);
  return { path, appended: true };
}

function scaffold(chatGuid: string, displayName: string | null): string {
  const header = displayName ? `# ${displayName}` : `# Group ${chatGuid.slice(0, 12)}`;
  const today = easternDate();
  return [
    header,
    "",
    `- **Chat GUID:** ${chatGuid}`,
    displayName ? `- **Display name:** ${displayName}` : "",
    `- **First seen:** ${today}`,
    "",
    "## Who's In It",
    "",
    "_(The participants — who they are to each other and to you. Cross-reference `persona/people/<handle>.md` for individual context.)_",
    "",
    "## Group Dynamic",
    "",
    "_(The vibe — how this group talks, in-jokes, recurring shorthand, who tends to drive conversation, your posture in here.)_",
    "",
    "## Recurring Topics",
    "",
    "_(Themes the group keeps coming back to — projects, plans, ongoing bits.)_",
    "",
    "## Open Items",
    "",
    "_(Things in flight at the group level — shared plans, follow-ups, decisions pending.)_",
    "",
    "## Shared History",
    "",
    "_(Dated group-level events worth remembering. Append here.)_",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .concat("\n");
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
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ") || lines[i]!.startsWith("### ")) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}
