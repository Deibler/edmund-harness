/**
 * Drift guard: skills must not instruct the model to call tools that
 * don't exist, and every SKILL.md must be discoverable.
 *
 * The rot being prevented (found 2026-07-28): `skills/voice-memo`
 * instructed `synthesize_speech(...)` months after TTS moved to
 * `generate_audio` (the system prompt carried the same ghost), and
 * `skills/design/SKILL.md` had no frontmatter — listed as
 * "(no description)" and effectively undiscoverable.
 *
 * Tool names are harvested STATICALLY from the registration sources
 * (`name: "..."` in src/mcp/tools/* and integrations/*, `server.tool("...")`
 * in the vendored RadarOmega server) so the test needs no live MCP
 * context. Inline-backtick call shapes (`tool_name(`) outside fenced
 * code blocks are treated as instructions to call that tool.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_ROOT = join(REPO, "skills");

/** Built-in Claude Code tools skills may legitimately reference. */
const BUILTINS = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "websearch",
  "webfetch",
  "toolsearch",
]);

/**
 * vendor/ is gitignored and rebuilt per machine, so it is absent on a fresh
 * checkout and in CI. Reading it unconditionally threw outside any test,
 * which made the run exit non-zero while reporting no failures. The two
 * checks that need those tool names say so and skip instead.
 */
const VENDORED_SERVER = join(REPO, "vendor", "radaromega-mcp", "src", "index.ts");
const HAS_VENDORED = existsSync(VENDORED_SERVER);

function harvestToolNames(): Set<string> {
  const names = new Set<string>();
  const fromSource = (path: string) => {
    const src = readFileSync(path, "utf8");
    for (const m of src.matchAll(/name:\s*"([a-z0-9_]+)"/g)) names.add(m[1]!);
    for (const m of src.matchAll(/server\.tool\(\s*\n?\s*"([a-z0-9_]+)"/g)) names.add(m[1]!);
  };
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) fromSource(p);
    }
  };
  walk(join(REPO, "src", "mcp", "tools"));
  walk(join(REPO, "integrations"));
  if (HAS_VENDORED) fromSource(VENDORED_SERVER);
  return names;
}

function skillFiles(): string[] {
  const out: string[] = [];
  const scan = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue; // .trash
      const p = join(dir, e.name);
      if (!e.isDirectory()) continue;
      const s = join(p, "SKILL.md");
      if (existsSync(s)) out.push(s);
      scan(p);
    }
  };
  scan(SKILLS_ROOT);
  return out;
}

describe("skill drift", () => {
  const tools = harvestToolNames();
  const files = skillFiles();

  test.skipIf(!HAS_VENDORED)(
    "harvest sanity: a healthy tool count and known anchors present",
    () => {
      expect(tools.size).toBeGreaterThan(100);
      for (const anchor of ["send_message", "generate_audio", "capture_view", "search_history"]) {
        expect(tools.has(anchor)).toBe(true);
      }
    },
  );

  test.skipIf(!HAS_VENDORED)(
    "every backticked tool call in every SKILL.md resolves to a real tool",
    () => {
      const unresolved: string[] = [];
      for (const f of files) {
        const body = readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, "");
        for (const m of body.matchAll(/`([a-z_][a-z0-9_]*)\(/g)) {
          const name = m[1]!;
          if (tools.has(name) || BUILTINS.has(name.toLowerCase())) continue;
          unresolved.push(`${f.slice(REPO.length + 1)} → \`${name}(\``);
        }
      }
      expect(unresolved).toEqual([]);
    },
  );

  test("every SKILL.md has frontmatter with a description", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const fm = src.match(/^---\n([\s\S]*?)\n---/);
      if (!fm || !/^description:\s*\S/m.test(fm[1]!)) bad.push(f.slice(REPO.length + 1));
    }
    expect(bad).toEqual([]);
  });

  test("the system prompt's tool references resolve too", () => {
    const src = readFileSync(join(REPO, "src", "claude", "system-prompt.ts"), "utf8");
    const unresolved: string[] = [];
    for (const m of src.matchAll(/\\?`([a-z_][a-z0-9_]*)\(/g)) {
      const name = m[1]!;
      if (tools.has(name) || BUILTINS.has(name.toLowerCase())) continue;
      unresolved.push(name);
    }
    expect([...new Set(unresolved)]).toEqual([]);
  });
});
