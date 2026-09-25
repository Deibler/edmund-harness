/**
 * Two enum fields the model kept filling with prose: remember_about_subject's
 * `outcome` got the whole story (8 times from 2026-09-19 to 09-25) and
 * remember_about_person got a "preferences" section that does not exist. The
 * published schema is all the model sees, so every allowed value, and where
 * the prose belongs, has to be in it.
 */
import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../src/mcp/context.ts";
import { memoryTools } from "../src/mcp/tools/memory.ts";
import { personTools } from "../src/mcp/tools/person.ts";
import { zodToJsonSchema } from "../src/mcp/zod-to-json.ts";

const ctx = {} as ToolContext;

function field(tools: ReturnType<typeof memoryTools>, tool: string, name: string) {
  const def = tools.find((t) => t.name === tool);
  if (!def) throw new Error(`no tool ${tool}`);
  const prop = zodToJsonSchema(def.inputSchema, tool).properties[name] as {
    enum?: string[];
    description?: string;
  };
  return { values: prop.enum ?? [], description: prop.description ?? "" };
}

describe("memory tool enums say what they take", () => {
  test("remember_about_subject's outcome names its four words and sends the story to `learned`", () => {
    const f = field(memoryTools(ctx), "remember_about_subject", "outcome");
    expect(f.values).toEqual(["worked", "rejected", "mixed", "untested"]);
    for (const v of f.values) expect(f.description).toContain(v);
    expect(f.description).toContain("`learned`");
  });

  test("remember_about_person's section names all five and where preferences go", () => {
    const f = field(personTools(ctx), "remember_about_person", "section");
    expect(f.values).toHaveLength(5);
    for (const v of f.values) expect(f.description).toContain(v);
    expect(f.description).toMatch(/preferences go in what-ive-learned/);
  });
});
