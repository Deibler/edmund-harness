import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { personFilePath } from "../claude/persona.ts";
import { easternDate } from "../util/clock.ts";

/**
 * Create a scaffold `persona/people/<handle>.md` the first time a contact
 * writes us. Called per inbound batch — no-op if the file already exists.
 *
 * The scaffold mirrors the openclaw structure (Who they are · Our dynamic ·
 * What I've learned · Shared history · Open items) so the model has a
 * consistent place to add notes.
 */
export function ensurePersonFile(handle: string, displayName: string | null): string | null {
  if (!handle) return null;
  const path = personFilePath(handle);
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, scaffold(handle, displayName));
  console.log(`[persona] created ${path}`);
  return path;
}

function scaffold(handle: string, displayName: string | null): string {
  const header = displayName ? `# ${displayName}` : `# ${handle}`;
  const today = easternDate();
  return [
    header,
    "",
    `- **Handle:** ${handle}`,
    displayName ? `- **Display name:** ${displayName}` : "",
    `- **First seen:** ${today}`,
    "",
    "## Who They Are",
    "",
    "_(Notes about the person — personality, background, what they care about.)_",
    "",
    "## Our Dynamic",
    "",
    "_(How this person likes to be talked to; your posture with them.)_",
    "",
    "## What I've Learned",
    "",
    "_(Preferences, quirks, recurring topics. Append here as you learn.)_",
    "",
    "## Shared History",
    "",
    "_(Dated events worth remembering. Append here.)_",
    "",
    "## Open Items",
    "",
    "_(Things in flight — follow-ups, promises, loose ends.)_",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .concat("\n");
}
