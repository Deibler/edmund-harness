import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { compactConfigFor } from "../src/model/runner.ts";
import type { Config } from "../src/config/config.ts";

/**
 * Codex must not inherit Claude's numbers.
 *
 * The two CLIs shared one `[claude]` block, and the values are only correct
 * for one of them. `context_window_tokens` reached Codex as
 * `model_context_window` — telling gpt-5.6-sol it had 400k of room against a
 * real 272k (`codex debug models`), which removes the headroom Codex uses to
 * manage its own context and trades a managed re-anchor for a hard API limit.
 * `effort` tuned for Opus ran a reasoning model at "medium" without anyone
 * choosing that.
 *
 * These read as configuration trivia and cost real capability, which is
 * exactly the kind of thing that survives a code review and hides for weeks.
 */

const SRC = join(import.meta.dir, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("codex does not inherit Claude's tuning", () => {
  test("the codex runner never reads a claude context window or effort", () => {
    const source = readFileSync(join(SRC, "codex", "runner.ts"), "utf8");
    expect(source).not.toContain("config.claude.context_window_tokens");
    expect(source).not.toContain("config.claude.effort");
    // It must read its own, so the override actually exists.
    expect(source).toContain("config.codex.context_window_tokens");
    expect(source).toContain("config.codex.effort");
  });

  test("no send path hands a codex re-anchor Claude's compact threshold", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("reanchorCodexIfNeeded(")) continue;
      // The call must route through compactConfigFor, which resolves per
      // backend. Passing the raw claude block is the regression.
      const idx = source.indexOf("reanchorCodexIfNeeded(");
      const call = source.slice(idx, idx + 260);
      if (call.includes("claude.auto_compact")) {
        offenders.push(file.replace(SRC, "src"));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("compactConfigFor gives codex its own threshold and leaves claude alone", () => {
    const config = {
      claude: { auto_compact: { enabled: true, threshold_tokens: 800_000 } },
      codex: { threshold_tokens: 200_000 },
    } as unknown as Config;

    expect(compactConfigFor("codex", config).threshold_tokens).toBe(200_000);
    expect(compactConfigFor("claude", config).threshold_tokens).toBe(800_000);
  });

  test("an unset codex threshold falls back rather than dropping to a default", () => {
    const config = {
      claude: { auto_compact: { enabled: true, threshold_tokens: 800_000 } },
      codex: {},
    } as unknown as Config;
    expect(compactConfigFor("codex", config).threshold_tokens).toBe(800_000);
  });
});
