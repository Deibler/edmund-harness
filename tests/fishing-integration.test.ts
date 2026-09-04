import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fishingTools } from "../integrations/fishing/tools.ts";
import { skillQueryScore } from "../src/mcp/tools/skills.ts";

const REPO = resolve(import.meta.dir, "..");

describe("fishing is a direct model capability", () => {
  test("an ordinary conversation gets the data tools, not a delegation tool", () => {
    const tools = fishingTools({
      config: { fishing: { enabled: true } },
      sandboxPath: "/tmp/fishing-tool-test",
    } as never);

    expect(tools.map((tool) => tool.name)).toEqual(["fishing_query", "fishing_viz"]);
    expect(tools.some((tool) => tool.name === "ask_fishing_expert")).toBe(false);
  });

  test("the model has a fishing skill that routes questions to those tools", () => {
    const path = resolve(REPO, "skills/fishing/SKILL.md");
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;

    const skill = readFileSync(path, "utf8");
    expect(skill).toContain("fishing_query");
    expect(skill).toContain("fishing_viz");
    expect(skill).not.toContain("ask_fishing_expert");
  });

  test("the multi-keyword discovery query from the failed Corey turn finds fishing", () => {
    const score = skillQueryScore("radaromega weather fishing current conditions", {
      name: "fishing",
      description:
        "Ground fishing questions in waterbody, species, gage, and observed-conditions data.",
    });
    expect(score).toBeGreaterThan(0);
  });
});
