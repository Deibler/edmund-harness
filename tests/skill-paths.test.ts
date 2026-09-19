import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallRecord } from "../src/skills/installer.ts";
import {
  curatedSkillsRoot,
  existingSkillRoot,
  skillDirectories,
  skillDirectoryForRecord,
} from "../src/skills/paths.ts";

function record(category: InstallRecord["category"]): InstallRecord {
  return {
    name: "example",
    source: category === "curated" ? "curated" : "self-authored",
    version: null,
    sha: "x",
    installed_at: 1,
    needs_approval: false,
    approved_at: null,
    has_scripts: false,
    disabled: false,
    category,
  };
}

describe("skill storage paths", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-paths-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("discovers normal and curated skills without exposing the container as a skill", () => {
    mkdirSync(join(root, "system-skill"), { recursive: true });
    writeFileSync(join(root, "system-skill", "SKILL.md"), "system");
    mkdirSync(join(root, "curated", "local-skill"), { recursive: true });
    writeFileSync(join(root, "curated", "local-skill", "SKILL.md"), "local");

    expect(skillDirectories(root).map((entry) => entry.name)).toEqual([
      "local-skill",
      "system-skill",
    ]);
  });

  test("curated records resolve under the gitignored curated root", () => {
    const curated = record("curated");
    expect(skillDirectoryForRecord(root, "example", curated)).toBe(
      join(root, "curated", "example"),
    );
    expect(existingSkillRoot(root, "example", curated)).toBe(curatedSkillsRoot(root));
  });

  test("a legacy root-level curated skill remains readable during migration", () => {
    mkdirSync(join(root, "example"), { recursive: true });
    expect(skillDirectoryForRecord(root, "example", record("curated"))).toBe(join(root, "example"));
    expect(existingSkillRoot(root, "example", record("curated"))).toBe(root);
  });
});
