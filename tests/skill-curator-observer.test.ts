import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import { SkillCurator, readCuratorState } from "../src/skills/curator-observer.ts";
import { type InstallRecord, writeDb } from "../src/skills/installer.ts";

/**
 * The curator's clock. A pass stopped by the skill ceiling did its work (the
 * lifecycle half) and must wait a full interval like any other. From
 * 2026-10-22, when the catalogue reached 12, it ran every hour instead.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "curator-clock-"));
  mkdirSync(join(dir, "skills"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function curator(curatedSkills: number): SkillCurator {
  const config = loadConfig(join(import.meta.dir, "..", "config.example.toml"));
  const skills: Record<string, InstallRecord> = {};
  for (let i = 0; i < curatedSkills; i++) {
    skills[`c-${i}`] = {
      name: `c-${i}`,
      source: "curated",
      version: null,
      sha: "x",
      installed_at: Date.now(),
      needs_approval: false,
      approved_at: null,
      has_scripts: false,
      disabled: false,
      category: "curated",
      scope: null,
    };
  }
  const dbPath = join(dir, "installed-skills.json");
  writeDb(dbPath, { version: 1, skills });
  return new SkillCurator({
    config,
    dataDir: dir,
    skillsRoot: join(dir, "skills"),
    dbPath,
    consentDbPath: join(dir, "consent.json"),
    contacts: new ContactBook([]),
    runModel: async () => {
      throw new Error("no model call expected");
    },
  });
}

describe("the curator's clock", () => {
  test("a pass stopped at the ceiling stamps it", async () => {
    const config = loadConfig(join(import.meta.dir, "..", "config.example.toml"));
    const out = await curator(config.skill_curator.max_curated_skills).runNow();
    expect(out.curated).toMatchObject({ ran: false, atCeiling: true });
    expect(readCuratorState(dir).last_run_ms).toBeGreaterThan(0);
  });

  test("a pass blocked for a passing reason leaves it alone", async () => {
    // No recall index yet: worth retrying at the next tick.
    const out = await curator(0).runNow();
    expect(out.curated.ran).toBe(false);
    expect(readCuratorState(dir).last_run_ms).toBe(0);
  });
});
