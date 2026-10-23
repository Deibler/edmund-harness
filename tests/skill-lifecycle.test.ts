import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import type { Config } from "../src/config/config.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import { StateStore } from "../src/sessions/store.ts";
import { updateAuthoredSkill } from "../src/skills/author.ts";
import { type InstallRecord, readDb, writeDb } from "../src/skills/installer.ts";
import {
  type LifecycleDeps,
  parseVerdict,
  retireUnusedCurated,
  reviewUsedCurated,
  reviseCurated,
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

function makeSkill(name: string, description: string, curated = true): void {
  const root = curated ? join(skillsRoot, "curated") : skillsRoot;
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
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
    expect(existsSync(join(skillsRoot, "curated", "ghost-skill", "SKILL.md"))).toBe(false);

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
    expect(existsSync(join(skillsRoot, "curated", "useful-skill", "SKILL.md"))).toBe(true);
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
    makeSkill("kaylas-skill", "Hers.", false);
    makeSkill("shop-skill", "From the marketplace.", false);
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
    makeSkill("chat-skill", "Grown out of one conversation.", false);
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
    expect(skillDescription(skillsRoot, "has-desc", record("has-desc"))).toBe(
      "The line people see.",
    );
    expect(skillDescription(skillsRoot, "missing")).toBe("");
  });
});

const BROAD = { people: 2, chats: 2, unrelated: true };

describe("a review verdict of revise", () => {
  const contacts = new ContactBook([{ name: "Morgan", handles: ["+15550004444"] }]);
  const curatedDir = () => join(skillsRoot, "curated");
  const setup = () => {
    makeSkill("race-week-plan", "Plan race week.");
    writeDb(dbPath, { version: 1, skills: { "race-week-plan": record("race-week-plan") } });
    return readDb(dbPath).skills["race-week-plan"]!;
  };

  test("rewrites the curated skill and records why", () => {
    const rec = setup();
    const ok = reviseCurated(
      "race-week-plan",
      rec,
      "Ask for the race date first, then build backwards from it.",
      "the asks were about taper timing",
      BROAD,
      { ...deps(), contacts },
    );
    expect(ok).toBe(true);
    const body = readFileSync(join(curatedDir(), "race-week-plan", "SKILL.md"), "utf8");
    expect(body).toContain("build backwards from it");
    expect(readDb(dbPath).skills["race-week-plan"]?.provenance?.at(-1)).toContain(
      "the asks were about taper timing",
    );
  });

  test("a revision carrying someone's name is refused", () => {
    const rec = setup();
    const ok = reviseCurated("race-week-plan", rec, "Ask Morgan for the date.", "x", BROAD, {
      ...deps(),
      contacts,
    });
    expect(ok).toBe(false);
    const body = readFileSync(join(curatedDir(), "race-week-plan", "SKILL.md"), "utf8");
    expect(body).toContain("Do the thing.");
  });

  test("without contacts for the leak scan, nothing is applied", () => {
    const rec = setup();
    expect(reviseCurated("race-week-plan", rec, "New steps here.", "x", BROAD, deps())).toBe(false);
  });

  test("a revision the asks of one person or one room support is refused", () => {
    const rec = setup();
    for (const narrow of [
      { people: 1, chats: 3, unrelated: false },
      { people: 3, chats: 1, unrelated: false },
      // A family: two people in two chats who share a room.
      { people: 2, chats: 2, unrelated: false },
    ]) {
      const ok = reviseCurated("race-week-plan", rec, "Plan their family's race.", "x", narrow, {
        ...deps(),
        contacts,
      });
      expect(ok).toBe(false);
    }
    const body = readFileSync(join(curatedDir(), "race-week-plan", "SKILL.md"), "utf8");
    expect(body).toContain("Do the thing.");
  });

  test("the review measures the asks it was shown", async () => {
    const A = "+15550005551";
    const B = "+15550005552";
    const FAM = "any;+;chatFAM";
    const dm = (h: string) => [`imessage:dm:${h}`, `any;-;${h}`, h] as const;
    const inGroup = (h: string) => [`imessage:group:${FAM}`, FAM, h] as const;
    // Each read: [session, chat, who asked just before it].
    for (const [reads, expectApplied] of [
      // Two strangers, each in their own DM.
      [[dm(A), dm(A), dm(B)], true],
      // One person, one DM.
      [[dm(A), dm(A), dm(A)], false],
      // A family: two members ask in their group, one also in a DM.
      [[inGroup(A), inGroup(B), dm(A)], false],
    ] as const) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(skillsRoot, { recursive: true });
      setup();
      const state = new StateStore(dir);
      const recall = new Database(join(dir, "recall.sqlite"));
      recall.exec(
        `CREATE TABLE rows (ref TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_guid TEXT, sender TEXT,
                            ts INTEGER NOT NULL, text TEXT NOT NULL, vec BLOB, model TEXT, dim INTEGER)`,
      );
      for (const [i, [session, chat, sender]] of reads.entries()) {
        state.upsertSession({
          sessionKey: session as `imessage:dm:${string}`,
          claudeSessionId: null,
          chatGuid: chat,
          isGroup: chat === FAM ? 1 : 0,
          lastInboundMs: 0,
          lastOutboundMs: 0,
        });
        recall
          .query("INSERT OR IGNORE INTO rows VALUES (?,?,?,?,?,?,x'00','m',1)")
          .run(`msg:${i}`, "message", chat, sender, Date.now() - 60_000, `plan my race week ${i}`);
        recordSkillRead(dir, "race-week-plan", session);
      }
      recall.close();
      state.close();
      await reviewUsedCurated({
        ...deps(),
        contacts,
        runModel: async () => ({
          ok: true,
          text: JSON.stringify({
            verdict: "revise",
            reason: "aimed slightly off",
            instructions: "Ask for the race date first, then build backwards from it.",
          }),
          error: null,
          status: 0,
          stderr: "",
          costUsd: 0,
          usage: null,
          model: "test",
          numTurns: 1,
          durationMs: 1,
        }),
      });
      const body = readFileSync(join(curatedDir(), "race-week-plan", "SKILL.md"), "utf8");
      expect(body.includes("build backwards")).toBe(expectApplied);
    }
  });

  test("a conversation still cannot edit a curated skill", () => {
    setup();
    const r = updateAuthoredSkill({
      name: "race-week-plan",
      instructions: "hijacked",
      extraFiles: [],
      sessionKey: "imessage:dm:+15550004444",
      opts: { skillsRoot: curatedDir(), dbPath, requireApprovalForScripts: true },
    });
    expect(r.ok).toBe(false);
  });
});
