/**
 * Self-authored skills: creation, scope privacy, updates, and the
 * script-approval gate surviving edits.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorSkill,
  buildSkillMd,
  skillVisibleTo,
  updateAuthoredSkill,
} from "../src/skills/author.ts";
import { type InstallOptions, readDb } from "../src/skills/installer.ts";

const DM_A = "imessage:dm:+15550100001";
const DM_B = "imessage:dm:+15550100002";

describe("self-authored skills", () => {
  let root: string;
  let opts: InstallOptions;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-author-"));
    opts = {
      skillsRoot: join(root, "skills"),
      dbPath: join(root, "installed-skills.json"),
      requireApprovalForScripts: true,
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("authorSkill writes SKILL.md with frontmatter and records chat scope", () => {
    const r = authorSkill({
      name: "class-report",
      description: "Weekly kid-by-kid classroom report",
      instructions: "1. Pull the week's notes.\n2. One paragraph per kid, every kid, every day.",
      extraFiles: [{ path: "template.md", content: "# Report\n" }],
      scope: DM_A,
      opts,
    });
    expect(r.ok).toBe(true);
    const md = readFileSync(join(opts.skillsRoot, "class-report", "SKILL.md"), "utf8");
    expect(md).toContain("name: class-report");
    expect(md).toContain("description: Weekly kid-by-kid classroom report");
    expect(md).toContain("every kid, every day");
    expect(existsSync(join(opts.skillsRoot, "class-report", "template.md"))).toBe(true);

    const rec = readDb(opts.dbPath).skills["class-report"];
    expect(rec?.source).toBe("self-authored");
    expect(rec?.scope).toBe(DM_A);
    expect(rec?.needs_approval).toBe(false);
  });

  test("chat-scoped skill is invisible to other sessions", () => {
    authorSkill({
      name: "private-skill",
      description: "x",
      instructions: "y",
      extraFiles: [],
      scope: DM_A,
      opts,
    });
    const rec = readDb(opts.dbPath).skills["private-skill"];
    expect(skillVisibleTo(rec, DM_A)).toBe(true);
    expect(skillVisibleTo(rec, DM_B)).toBe(false);
    // Global (scope null) and pre-shipped (no record) skills are visible everywhere.
    expect(skillVisibleTo({ ...rec!, scope: null }, DM_B)).toBe(true);
    expect(skillVisibleTo(undefined, DM_B)).toBe(true);
  });

  test("scripts flag needs_approval, and an update re-arms the gate", () => {
    const r = authorSkill({
      name: "scripted",
      description: "ships a script",
      instructions: "run scripts/go.sh",
      extraFiles: [{ path: "scripts/go.sh", content: "#!/bin/sh\necho hi\n" }],
      scope: null,
      opts,
    });
    expect(r.ok && r.record.needs_approval).toBe(true);

    // Simulate operator approval, then an edit.
    const db = readDb(opts.dbPath);
    db.skills.scripted!.needs_approval = false;
    db.skills.scripted!.approved_at = 123;
    writeFileSync(opts.dbPath, JSON.stringify(db));

    const u = updateAuthoredSkill({
      name: "scripted",
      instructions: "run scripts/go.sh twice",
      extraFiles: [],
      sessionKey: DM_A,
      opts,
    });
    expect(u.ok).toBe(true);
    const rec = readDb(opts.dbPath).skills.scripted!;
    expect(rec.needs_approval).toBe(true);
    expect(rec.approved_at).toBeNull();
  });

  test("update preserves description when omitted and rejects cross-chat edits", () => {
    authorSkill({
      name: "mine",
      description: "original description",
      instructions: "v1",
      extraFiles: [],
      scope: DM_A,
      opts,
    });

    const stranger = updateAuthoredSkill({
      name: "mine",
      instructions: "hijacked",
      extraFiles: [],
      sessionKey: DM_B,
      opts,
    });
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.reason).toMatch(/another chat/);

    const owner = updateAuthoredSkill({
      name: "mine",
      instructions: "v2 with the fix",
      extraFiles: [],
      sessionKey: DM_A,
      opts,
    });
    expect(owner.ok).toBe(true);
    const md = readFileSync(join(opts.skillsRoot, "mine", "SKILL.md"), "utf8");
    expect(md).toContain("description: original description");
    expect(md).toContain("v2 with the fix");
  });

  test("update refuses non-self-authored skills and duplicate creates are rejected", () => {
    authorSkill({
      name: "dup",
      description: "d",
      instructions: "i",
      extraFiles: [],
      scope: null,
      opts,
    });
    const again = authorSkill({
      name: "dup",
      description: "d2",
      instructions: "i2",
      extraFiles: [],
      scope: null,
      opts,
    });
    expect(again.ok).toBe(false);

    const db = readDb(opts.dbPath);
    db.skills.dup!.source = "anthropics/skills";
    writeFileSync(opts.dbPath, JSON.stringify(db));
    const u = updateAuthoredSkill({
      name: "dup",
      instructions: "x",
      extraFiles: [],
      sessionKey: DM_A,
      opts,
    });
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.reason).toMatch(/only self-authored/);
  });

  test("buildSkillMd flattens multi-line descriptions for the catalog", () => {
    const md = buildSkillMd("n", "line one\nline two", "body");
    expect(md).toContain("description: line one line two");
  });
});
