import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `persona/` is gitignored — a real one fills with details about real people —
 * so `persona.example/` is the only persona a fresh clone gets. If it drifts
 * out of sync with what the prompt builder reads, the failure is silent: the
 * harness boots, replies, and is simply nobody. These tests keep the template
 * honest about the file names the loader actually looks for.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = join(REPO, "persona.example");

/** Kept in step with ORCH_PERSONA_FILES in src/claude/persona.ts. */
const REQUIRED = [
  "IDENTITY.md",
  "SOUL.md",
  "AGENTS.md",
  "VENUE_DM.md",
  "VENUE_GROUP.md",
  "VENUE_MIRROR.md",
  "HOME.md",
];

describe("persona.example", () => {
  test("exists — a fresh clone must have a persona to copy", () => {
    expect(existsSync(EXAMPLE)).toBe(true);
  });

  test("covers every file the prompt builder reads", () => {
    const present = new Set(readdirSync(EXAMPLE));
    for (const f of REQUIRED) expect(present.has(f)).toBe(true);
  });

  test("ships the GHOST template used by proactive ticks", () => {
    expect(existsSync(join(EXAMPLE, "GHOST.md"))).toBe(true);
  });

  test("stays in step with persona.ts ORCH_PERSONA_FILES", () => {
    // If someone adds a persona file to the loader, this fails until the
    // template gains one too — which is the whole point.
    const src = readFileSync(join(REPO, "src/claude/persona.ts"), "utf8");
    const block = src.match(/ORCH_PERSONA_FILES\s*(?::[^=]*)?=\s*\[([\s\S]*?)\]/);
    expect(block).not.toBeNull();
    const declared = [...(block?.[1] ?? "").matchAll(/"([^"]+\.md)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    const present = new Set(readdirSync(EXAMPLE));
    for (const f of declared) expect(present.has(f as string)).toBe(true);
  });

  test("sub-directories the loader resolves are represented", () => {
    for (const d of ["people", "groups", "orchestrators", "sessions"]) {
      expect(existsSync(join(EXAMPLE, d))).toBe(true);
    }
  });

  test("templates carry no leading H1 that would double the builder's heading", () => {
    // buildSystemPrompt wraps these in its own `# Identity` / `# Memory` /
    // `# Home` section headers.
    for (const f of ["IDENTITY.md", "SOUL.md", "HOME.md"]) {
      const first = readFileSync(join(EXAMPLE, f), "utf8").split("\n")[0] ?? "";
      expect(first.startsWith("# ")).toBe(false);
    }
  });

  test("venue templates keep the {{senderLabel}} substitution token", () => {
    const dm = readFileSync(join(EXAMPLE, "VENUE_DM.md"), "utf8");
    expect(dm).toContain("{{senderLabel}}");
  });
});
