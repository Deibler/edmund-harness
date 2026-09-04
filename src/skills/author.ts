/**
 * Self-authored skills — the model crystallizing a repeated ask into a
 * durable skill it wrote itself. Reuses the marketplace installer's
 * vetting + atomic-write machinery, with two twists:
 *
 *   1. `source` is the literal "self-authored" (no remote registry).
 *   2. `scope` privacy: a skill born from one person's conversation
 *      defaults to being visible ONLY in that session. Cross-chat
 *      visibility ("everyone") is an explicit choice the model makes,
 *      and persona rules forbid putting person-file content in it.
 *
 * Scripts inside a self-authored skill go through the exact same
 * operator-approval gate as marketplace installs — the model can write
 * itself a script, but it cannot run it until the operator approves via
 * `edmund skills approve <name>`. Updating a skill that ships scripts
 * RESETS approval: a post-approval edit must be re-approved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { revokeConsentFor } from "./consent.ts";
import {
  type InstallOptions,
  type InstallRecord,
  categoryOf,
  installSkill,
  isValidSkillName,
  readDb,
  vetFiles,
  writeDb,
} from "./installer.ts";
import type { SkillFile } from "./registry.ts";

const SELF_SOURCE = "self-authored";

export type AuthorInput = {
  name: string;
  description: string;
  /** Markdown body of SKILL.md (everything below the frontmatter). */
  instructions: string;
  /** Extra files shipped alongside SKILL.md (templates, reference data, scripts). */
  extraFiles: SkillFile[];
  /** Session key this skill is private to, or null for everyone. */
  scope: string | null;
  /** Session it was authored in. Kept even when scope is null, so a
   *  share='everyone' skill still has an owner who may publish it. */
  originScope?: string | null;
  opts: InstallOptions;
};

export type AuthorResult = { ok: true; record: InstallRecord } | { ok: false; reason: string };

export function buildSkillMd(name: string, description: string, instructions: string): string {
  // Keep the frontmatter single-line-safe: description feeds list_skills.
  const desc = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${instructions.trim()}\n`;
}

export function authorSkill(input: AuthorInput): AuthorResult {
  const { name, description, instructions, extraFiles, scope, opts } = input;
  if (!isValidSkillName(name)) return { ok: false, reason: `invalid skill name: ${name}` };
  if (!description.trim()) return { ok: false, reason: "description must not be empty" };
  if (!instructions.trim()) return { ok: false, reason: "instructions must not be empty" };
  if (extraFiles.some((f) => f.path === "SKILL.md")) {
    return {
      ok: false,
      reason: "SKILL.md is generated from instructions — don't pass it as an extra file",
    };
  }

  const files: SkillFile[] = [
    { path: "SKILL.md", content: buildSkillMd(name, description, instructions) },
    ...extraFiles,
  ];

  const result = installSkill({ name, source: SELF_SOURCE, version: null, files, opts });
  if (!result.installed) return { ok: false, reason: result.reason };

  // installSkill wrote the record; stamp the scope and provenance on top.
  const db = readDb(opts.dbPath);
  const record = db.skills[name];
  if (record) {
    record.scope = scope;
    record.category = "self";
    // Where it was born, recorded even when the model chose share='everyone'.
    // Without this a globally-shared self skill has no owner, and publishing
    // it later has nobody to attribute it to and nobody entitled to do it.
    record.origin_scope = input.originScope ?? scope;
    writeDb(opts.dbPath, db);
    return { ok: true, record };
  }
  return { ok: true, record: result.record };
}

export type UpdateInput = {
  name: string;
  /** New description; omit to keep current. */
  description?: string;
  /** New SKILL.md body; omit to keep current. */
  instructions?: string;
  /** Files to add or overwrite by path. Existing files not named here are kept. */
  extraFiles: SkillFile[];
  /** Caller's session key — must match the skill's scope unless scope is null. */
  sessionKey: string;
  /** Consent store. Editing a PUBLISHED skill revokes every consent given to
   *  it: people agreed to the skill they were told about, not to whatever it
   *  is rewritten into afterwards. Omit for skills that cannot be public. */
  consentDbPath?: string;
  opts: InstallOptions;
};

export function updateAuthoredSkill(input: UpdateInput): AuthorResult {
  const { name, sessionKey, opts } = input;
  if (!isValidSkillName(name)) return { ok: false, reason: `invalid skill name: ${name}` };

  const db = readDb(opts.dbPath);
  const record = db.skills[name];
  if (!record) return { ok: false, reason: `not a managed skill: ${name}` };
  if (record.source !== SELF_SOURCE) {
    return {
      ok: false,
      reason: `${name} came from ${record.source} — only self-authored skills can be edited`,
    };
  }
  // Ownership. `scope` alone is not enough: publishing sets scope to null so
  // everyone can see the skill, which would otherwise let any reader edit
  // someone else's published playbook. The author is `origin_scope`.
  const owner = record.origin_scope ?? record.scope;
  if (owner && owner !== sessionKey) {
    return { ok: false, reason: `${name} belongs to another chat` };
  }
  if (!owner && record.scope && record.scope !== sessionKey) {
    return { ok: false, reason: `${name} belongs to another chat` };
  }
  if (!owner && categoryOf(record) === "public") {
    return {
      ok: false,
      reason: `${name} is published and has no recorded author — it cannot be edited`,
    };
  }

  const skillDir = resolve(opts.skillsRoot, name);
  if (!skillDir.startsWith(`${resolve(opts.skillsRoot)}/`)) {
    return { ok: false, reason: "resolved path escapes skills root" };
  }
  const manifestPath = resolve(skillDir, "SKILL.md");
  if (!existsSync(manifestPath))
    return { ok: false, reason: `skill dir missing SKILL.md: ${name}` };

  const current = parseSkillMd(readFileSync(manifestPath, "utf8"));
  const description = input.description?.trim() || current.description;
  const instructions = input.instructions?.trim() || current.instructions;
  if (input.extraFiles.some((f) => f.path === "SKILL.md")) {
    return {
      ok: false,
      reason: "pass instructions/description to edit SKILL.md, not an extra file",
    };
  }

  const files: SkillFile[] = [
    { path: "SKILL.md", content: buildSkillMd(name, description, instructions) },
    ...input.extraFiles,
  ];
  const vet = vetFiles(files);
  if (!vet.ok) return { ok: false, reason: vet.reason };

  for (const f of files) {
    const dest = resolve(skillDir, f.path);
    if (!dest.startsWith(`${skillDir}/`)) return { ok: false, reason: `path escape: ${f.path}` };
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
  }

  const hasScripts = record.has_scripts || vet.hasScripts;
  record.has_scripts = hasScripts;
  // Security: any update that leaves the skill holding scripts re-requires
  // approval — otherwise approve-once-then-edit would be a bypass.
  record.needs_approval = hasScripts && opts.requireApprovalForScripts;
  if (record.needs_approval) record.approved_at = null;
  record.updated_at = Date.now();
  writeDb(opts.dbPath, db);
  if (categoryOf(record) === "public" && input.consentDbPath) {
    revokeConsentFor(name, input.consentDbPath);
  }
  return { ok: true, record };
}

/** Visibility check shared by list_skills / read_skill. */
export function skillVisibleTo(record: InstallRecord | undefined, sessionKey: string): boolean {
  if (!record) return true; // pre-shipped skills have no record → global
  if (record.disabled) return false;
  return !record.scope || record.scope === sessionKey;
}

function parseSkillMd(md: string): { description: string; instructions: string } {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?/);
  let description = "";
  if (fm?.[1]) {
    const line = fm[1].split("\n").find((l) => l.trim().toLowerCase().startsWith("description:"));
    if (line)
      description = line
        .replace(/^[^:]*:\s*/, "")
        .trim()
        .replace(/^["']|["']$/g, "");
  }
  const instructions = fm ? md.slice(fm[0].length).trim() : md.trim();
  return { description, instructions };
}
