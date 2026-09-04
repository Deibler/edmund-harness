import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import type { Config } from "../src/config/config.ts";
import { type InstallRecord, readDb, writeDb } from "../src/skills/installer.ts";
import {
  type LifecycleDeps,
  parseVerdict,
  retireUnusedCurated,
  skillDescription,
  usageRetentionDays,
} from "../src/skills/lifecycle.ts";
import {
  pruneUsage,
  readUsageEvents,
  recordSkillRead,
  summarizeUsage,
} from "../src/skills/usage.ts";

/**
 * The half of the curator that deletes.
 *
 * A curator that only adds is a ratchet: the catalogue grows, the model reads
 * all of it to decide what it can do, and the good entries get harder to find
 * among the plausible ones. Retirement is what keeps the catalogue honest, so
 * it needs to be right about two things — never retiring something people are
 * using, and never retiring something that is not the curator's to delete.
 */

const DAY = 86_400_000;

let dir: string;
let skillsRoot: string;
let dbPath: string;
let config: Config;

function makeSkill(name: string, description: string): void {
  mkdirSync(join(skillsRoot, name), { recursive: true });
  writeFileSync(
    join(skillsRoot, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`,
  );
}

function record(name: string, overrides: Partial<InstallRecord> = {}): InstallRecord {
  return {
    name,
    source: "curated",
    version: null,
    sha: "x",
    installed_at: Date.now() - 100 * DAY,
    needs_approval: false,
    approved_at: null,
    has_scripts: false,
    disabled: false,
    category: "curated",
    scope: null,
    ...overrides,
  };
}

function deps(now = Date.now()): LifecycleDeps {
  return {
    config,
    dataDir: dir,
    skillsRoot,
    dbPath,
    consentDbPath: join(dir, "consent.json"),
    now: () => now,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  skillsRoot = join(dir, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  dbPath = join(dir, "installed-skills.json");
  // Schema defaults, so the test pins the shipped numbers rather than its own.
  config = loadConfig(join(import.meta.dir, "..", "config.example.toml"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("retiring what nobody reaches for", () => {
  test("an unread curated skill past the grace period goes, with a tombstone", () => {
    makeSkill("ghost-skill", "Something nobody ever wanted.");
    writeDb(dbPath, { version: 1, skills: { "ghost-skill": record("ghost-skill") } });

    const retired = retireUnusedCurated(deps());
    expect(retired.map((r) => r.name)).toEqual(["ghost-skill"]);
    expect(existsSync(join(skillsRoot, "ghost-skill", "SKILL.md"))).toBe(false);

    const db = readDb(dbPath);
    expect(db.skills["ghost-skill"]).toBeUndefined();
    // The tombstone keeps the description, which is only readable BEFORE the
    // directory moves to .trash — retire first and it is lost.
    expect(db.retired?.["ghost-skill"]?.description).toBe("Something nobody ever wanted.");
    expect(db.retired?.["ghost-skill"]?.reason).toContain("never read");
  });

  test("a skill someone actually read is kept", () => {
    makeSkill("useful-skill", "Something people use.");
    writeDb(dbPath, { version: 1, skills: { "useful-skill": record("useful-skill") } });
    recordSkillRead(dir, "useful-skill", "imessage:dm:+15550001111");

    expect(retireUnusedCurated(deps())).toEqual([]);
    expect(existsSync(join(skillsRoot, "useful-skill", "SKILL.md"))).toBe(true);
  });

  test("a brand-new curated skill is given its grace period", () => {
    makeSkill("new-skill", "Written yesterday.");
    writeDb(dbPath, {
      version: 1,
      skills: { "new-skill": record("new-skill", { installed_at: Date.now() - DAY }) },
    });
    expect(retireUnusedCurated(deps())).toEqual([]);
  });

  test("a person's own skill is never retired, however long it sits unread", () => {
    // Unused is not a defect in something someone chose to keep, and this
    // pass has no standing to delete it.
    makeSkill("kaylas-skill", "Hers.");
    makeSkill("shop-skill", "From the marketplace.");
    writeDb(dbPath, {
      version: 1,
      skills: {
        "kaylas-skill": record("kaylas-skill", {
          category: "public",
          source: "self-authored",
          publisher: "+15550001111",
        }),
        "shop-skill": record("shop-skill", {
          category: "marketplace",
          source: "anthropics/skills",
        }),
      },
    });
    expect(retireUnusedCurated(deps())).toEqual([]);
    expect(existsSync(join(skillsRoot, "kaylas-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsRoot, "shop-skill", "SKILL.md"))).toBe(true);
  });

  test("a self-authored skill the model wrote for one chat is never retired", () => {
    makeSkill("chat-skill", "Grown out of one conversation.");
    writeDb(dbPath, {
      version: 1,
      skills: {
        "chat-skill": record("chat-skill", {
          category: "self",
          source: "self-authored",
          scope: "imessage:dm:+15550001111",
        }),
      },
    });
    expect(retireUnusedCurated(deps())).toEqual([]);
  });
});

describe("the retention trap", () => {
  test("usage history always outlives the grace period", () => {
    // THE bug this pass could have: if the usage log is pruned faster than
    // the grace period, a skill read once on day one looks unread on day
    // forty, and retirement deletes exactly the skills that are working.
    // Retention is derived from the grace period rather than configured
    // beside it, so the two cannot drift apart.
    for (const grace of [1, 7, 30, 45, 90, 365]) {
      expect(usageRetentionDays(grace)).toBeGreaterThan(grace);
    }
  });

  test("pruning keeps everything inside the retention window", () => {
    const now = Date.now();
    recordSkillRead(dir, "old-read", "s1");
    recordSkillRead(dir, "recent-read", "s2");
    // Rewrite one event to be ancient.
    const events = readUsageEvents(dir).map((e) =>
      e.skill === "old-read" ? { ...e, at_ms: now - 500 * DAY } : e,
    );
    writeFileSync(
      join(dir, "skill-usage.jsonl"),
      events.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );

    pruneUsage(dir, usageRetentionDays(30), now);
    const kept = readUsageEvents(dir).map((e) => e.skill);
    expect(kept).toContain("recent-read");
    expect(kept).not.toContain("old-read");
  });
});

describe("the usage log", () => {
  test("counts reads and the distinct conversations they came from", () => {
    recordSkillRead(dir, "s", "chatA");
    recordSkillRead(dir, "s", "chatA");
    recordSkillRead(dir, "s", "chatB");
    const summary = summarizeUsage(readUsageEvents(dir)).get("s");
    expect(summary?.reads).toBe(3);
    expect(summary?.sessions.size).toBe(2);
  });

  test("a torn line from a crashed append does not lose the rest of the log", () => {
    recordSkillRead(dir, "before", "chatA");
    writeFileSync(join(dir, "skill-usage.jsonl"), `${'{"skill":"before"'}\n`, { flag: "a" });
    recordSkillRead(dir, "after", "chatA");
    const skills = readUsageEvents(dir).map((e) => e.skill);
    expect(skills).toContain("before");
    expect(skills).toContain("after");
  });
});

describe("reading a review verdict", () => {
  test("the three verdicts parse, fenced or not", () => {
    expect(parseVerdict(`{"verdict":"keep","reason":"it matches"}`)?.verdict).toBe("keep");
    expect(parseVerdict('```json\n{"verdict":"retire","reason":"incidental"}\n```')?.verdict).toBe(
      "retire",
    );
    const revise = parseVerdict(`{"verdict":"revise","reason":"vague","instructions":"Better."}`);
    expect(revise?.instructions).toBe("Better.");
  });

  test("an unrecognised verdict yields nothing rather than a default", () => {
    // Defaulting to "keep" here would launder a broken response into an
    // endorsement, which is exactly what the review exists to avoid.
    expect(parseVerdict(`{"verdict":"probably fine"}`)).toBeNull();
    expect(parseVerdict("I think it is good")).toBeNull();
  });
});

describe("reading a description off disk", () => {
  test("returns the catalogue line, and empty when the skill is gone", () => {
    makeSkill("has-desc", "The line people see.");
    expect(skillDescription(skillsRoot, "has-desc")).toBe("The line people see.");
    expect(skillDescription(skillsRoot, "missing")).toBe("");
  });
});
