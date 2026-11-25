import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// mtime-keyed cache for persona markdown. The daemon re-reads these files
// every turn so edits land without a restart, but reading 30+ KB of static
// markdown on every inbound message added measurable disk I/O and (worse)
// busted any chance of skipping CPU work upstream. statSync is ~µs; reading
// + decoding AGENTS.md (22 KB) is ~ms. We keep the "edits apply live"
// property by invalidating on mtime change.
const fileCache = new Map<string, { mtimeMs: number; text: string | undefined }>();

export type Persona = {
  identity?: string;
  soul?: string;
  person?: { name: string; slug: string; path: string; body: string };
};

// Anchored to this module's location, not process.cwd(). The daemon
// launches with cwd=repo-root (see LaunchAgent plist WorkingDirectory), but
// relying on that was a latent foot-gun: any caller that imported this from
// a different cwd (dashboard, CLI subcommand, ad-hoc script) would look for
// persona/ in the wrong place and silently get no files. Going up three
// levels from `src/model/persona.ts` lands at the repo root.
export const PERSONA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "persona");
export const PEOPLE_DIR = join(PERSONA_DIR, "people");
export const GROUPS_DIR = join(PERSONA_DIR, "groups");
/** Guest campaign context files — repo root `campaigns/`, beside persona/. */
const CAMPAIGNS_DIR = join(dirname(PERSONA_DIR), "campaigns");

/** One of the persona files at the top of `persona/`, or undefined when it is absent or empty. */
export function readPersonaFile(file: string): string | undefined {
  return readOptional(join(PERSONA_DIR, file));
}

/**
 * Load persona files from disk. Called per turn so edits take effect without
 * restart.
 *
 * Per-sender file is keyed by **handle** (phone/email), not name — names
 * aren't unique (two people with the same name, name changes, etc.) but handles are.
 * Filename format:
 *   phone  → "+15550100001"    → "15550100001.md"
 *   email  → "alex@icloud.com" → "alex-icloud-com.md"
 */
export function loadPersona(senderLabel: string | null, rawHandle: string | null): Persona {
  return {
    identity: readPersonaFile("IDENTITY.md"),
    soul: readPersonaFile("SOUL.md"),
    person: resolvePersonFile(senderLabel, rawHandle),
  };
}

/**
 * Compute a SHA-256 fingerprint of the *shared* persona surface — the
 * files every session reads (IDENTITY, SOUL, VENUE_DM, VENUE_GROUP).
 * Used by runClaude to detect persona edits between turns and force a
 * cold spawn when the operator (or the model itself) has tuned the prompt.
 *
 * Deliberately EXCLUDES per-sender files (`persona/people/<handle>.md`,
 * `persona/groups/<slug>.md`). Those change every turn the background
 * maintainer runs; invalidating on each would defeat warm-session reuse
 * and Anthropic prompt caching. Small per-sender additions get appended
 * via `--append-system-prompt` and the model handles them fine.
 *
 * Also includes a hard-coded version stamp so changes to the code-baked
 * rules (OUTPUT_RULES, MEMORY_RULES, EPISTEMIC_RULES in system-prompt.ts)
 * can trigger invalidation by bumping the stamp.
 */
export function personaFingerprint(): string {
  const parts: string[] = [SHARED_PROMPT_VERSION];
  for (const name of [
    "IDENTITY.md",
    "SOUL.md",
    "VENUE_DM.md",
    "VENUE_GROUP.md",
    "VENUE_MIRROR.md",
    "HOME.md",
  ]) {
    parts.push(`${name}:${readOptional(join(PERSONA_DIR, name)) ?? ""}`);
  }
  // Guest campaign context files (campaigns/*.md) — appended to keyed-guest
  // system prompts, so editing one must cold-respawn the (guest) sessions
  // that baked it. Scanned by directory, not config, so every caller of
  // this zero-arg function computes the same hash. A campaign file stored
  // outside campaigns/ escapes the fingerprint — keep them here.
  if (existsSync(CAMPAIGNS_DIR)) {
    for (const f of readdirSync(CAMPAIGNS_DIR).sort()) {
      if (!f.endsWith(".md")) continue;
      const text = readOptional(join(CAMPAIGNS_DIR, f));
      if (text !== undefined) parts.push(`campaigns/${f}:${text}`);
    }
  }
  const hash = new Bun.CryptoHasher("sha256").update(parts.join("\n---\n")).digest("hex");
  return hash as string;
}

/** Bump this string whenever you change the code-baked rules in
 *  system-prompt.ts (OUTPUT_RULES, MEMORY_RULES, EPISTEMIC_RULES, TOOLS_TEXT)
 *  to force every session to cold-spawn on next turn. The actual content
 *  of those rules isn't in the fingerprint (it lives in source, not files),
 *  so this version stamp is how code changes propagate. */
const SHARED_PROMPT_VERSION = "v2026.11.25.a";

/**
 * @public Imported by src/persona/{crud,write-note,ensure,maintainer}.ts.
 *
 * Tagged because knip does not resolve those importers and reports this as
 * unused; removing it fails the typecheck immediately.
 */
export function personFilePath(handle: string): string {
  return join(PEOPLE_DIR, `${slugify(handle)}.md`);
}

/**
 * Path for a group chat's persona file. Keyed by chatGuid (not display name)
 * because group display names change as people get added or someone renames
 * the chat; the GUID is the only stable identifier across renames.
 */
export function groupFilePath(chatGuid: string): string {
  return join(GROUPS_DIR, `${slugify(chatGuid)}.md`);
}

function resolvePersonFile(
  senderLabel: string | null,
  rawHandle: string | null,
): Persona["person"] {
  if (!rawHandle) return undefined;
  const slug = slugify(rawHandle);
  const path = personFilePath(rawHandle);
  const body = readOptional(path);
  if (!body) return undefined;
  return { name: senderLabel ?? rawHandle, slug, path, body };
}

export function readOptional(path: string): string | undefined {
  if (!existsSync(path)) {
    fileCache.delete(path);
    return undefined;
  }
  const mtimeMs = statSync(path).mtimeMs;
  const hit = fileCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.text;
  const raw = readFileSync(path, "utf8").trim();
  const text = raw.length > 0 ? raw : undefined;
  fileCache.set(path, { mtimeMs, text });
  return text;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
