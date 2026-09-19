import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type InstallRecord, categoryOf } from "./installer.ts";

export const CURATED_SKILLS_DIR = "curated";

export function curatedSkillsRoot(skillsRoot: string): string {
  return join(skillsRoot, CURATED_SKILLS_DIR);
}

export function skillRootForRecord(skillsRoot: string, record: InstallRecord | undefined): string {
  return categoryOf(record) === "curated" ? curatedSkillsRoot(skillsRoot) : skillsRoot;
}

export function skillDirectoryForRecord(
  skillsRoot: string,
  name: string,
  record: InstallRecord | undefined,
): string {
  const preferred = join(skillRootForRecord(skillsRoot, record), name);
  if (existsSync(preferred)) return preferred;

  const legacy = join(skillsRoot, name);
  if (categoryOf(record) === "curated" && existsSync(legacy)) return legacy;
  return preferred;
}

export function existingSkillRoot(
  skillsRoot: string,
  name: string,
  record: InstallRecord | undefined,
): string {
  return dirname(skillDirectoryForRecord(skillsRoot, name, record));
}

export type SkillDirectory = { name: string; dir: string };

export function skillDirectories(skillsRoot: string): SkillDirectory[] {
  if (!existsSync(skillsRoot)) return [];
  const found = new Map<string, SkillDirectory>();

  const collect = (root: string, skipCuratedContainer: boolean) => {
    if (!existsSync(root)) return;
    for (const name of readdirSync(root).sort()) {
      if (name.startsWith(".")) continue;
      if (skipCuratedContainer && name === CURATED_SKILLS_DIR) continue;
      const dir = join(root, name);
      if (!statSync(dir).isDirectory()) continue;
      found.set(name, { name, dir });
    }
  };

  collect(skillsRoot, true);
  collect(curatedSkillsRoot(skillsRoot), false);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
