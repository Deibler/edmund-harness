/**
 * The boot self-check names a bad [claude].agent_model. Ten sub-agents once
 * failed at start on a dotted "claude-sonnet-5.5", each failure reaching the
 * parent turn one at a time; the check validated only the main model.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLoadout } from "../src/claude/loadout-check.ts";

const agentWarnings = (agentModel?: string) =>
  checkLoadout(undefined, agentModel).warnings.filter((w) => w.includes("agent_model"));

describe("the boot loadout check", () => {
  test("a malformed agent_model is reported at boot", () => {
    const [warning] = agentWarnings("claude-sonnet-5.5");
    expect(warning).toContain('"claude-sonnet-5.5" cannot start a sub-agent');
    expect(warning).toContain('"claude-sonnet-5-5"');
    expect(agentWarnings(" ")).toHaveLength(1);
  });

  test("a well-formed one is not", () => {
    expect(agentWarnings("claude-sonnet-5")).toEqual([]);
    expect(agentWarnings(undefined)).toEqual([]);
  });

  test("the daemon passes it", () => {
    const main = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
    expect(main).toContain("checkLoadout(config.claude.model, config.claude.agent_model)");
  });
});
