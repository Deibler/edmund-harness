/**
 * A deployment keeps its real household detail in SKILL.local.md; the tracked
 * SKILL.md is the publishable version. The model reads the overlay when it
 * exists. Watched fail before the helper existed.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { skillManifestPath } from "../src/mcp/tools/skills.ts";

describe("skill overlay", () => {
  test("SKILL.local.md wins when present, SKILL.md otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "edh-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: public\n---\n");
    expect(skillManifestPath(dir)).toBe(join(dir, "SKILL.md"));
    writeFileSync(join(dir, "SKILL.local.md"), "---\ndescription: private\n---\n");
    expect(skillManifestPath(dir)).toBe(join(dir, "SKILL.local.md"));
  });
  test("read_skill and list_skills go through it; publish does not", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/mcp/tools/skills.ts"), "utf8");
    const read = src.slice(src.indexOf('name: "read_skill"'), src.indexOf('name: "create_skill"'));
    expect(read).toContain("skillManifestPath(");
    const list = src.slice(src.indexOf("function listSkills()"));
    expect(list).toContain("skillManifestPath(dir)");
    const publish = src.slice(
      src.indexOf('name: "publish_skill"'),
      src.indexOf('name: "unpublish_skill"'),
    );
    expect(publish).toContain('"SKILL.md"');
    expect(publish).not.toContain("skillManifestPath(");
  });
});
