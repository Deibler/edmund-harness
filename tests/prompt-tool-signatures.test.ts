/**
 * Where the harness tells the model how to call a tool, it names arguments
 * the tool has.
 *
 * The system prompt lists the tools as `name(arg, arg?)`. Nothing held that
 * list to the tools' schemas, and by 2026-11-25 four entries had drifted:
 * `react(target_msg_guid, reaction)` (the field is `target_guid`),
 * `message_contact(handle, text)`, `generate_audio(prompt, …)` and
 * `generate_video(…, image?)`. A misnamed required argument costs a failed
 * call and a retry (17 `message_contact` calls in a month). A misnamed
 * optional one was dropped without a word, and the tool did something else:
 * ten reactions lost the id they named and went to the newest message.
 *
 * This reads every signature written in backticks in the source and in the
 * tracked skills, which are prompt text too, and checks each argument against
 * the schema of the tool with that name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Glob } from "bun";
import type { z } from "zod";
import { ConfigSchema } from "../src/config/config.ts";
import { assembleCoreTools } from "../src/mcp/server.ts";

const ROOT = join(import.meta.dir, "..");

/** Every core tool's argument names; null where the input is not one plain object. */
function toolArguments(): Map<string, string[] | null> {
  const config = ConfigSchema.parse({
    self: { handles: [] },
    allowlist: { dm: [], groups: [] },
    identity: {},
  });
  config.paths.data_dir = tmpdir();
  const tools = assembleCoreTools({
    config,
    cron: null,
    chatDb: null,
    contacts: null,
    sessionKey: "imessage:dm:+15559990000",
    chatGuids: [],
    sandboxPath: tmpdir(),
    dataDir: tmpdir(),
    bgJobs: null,
    guestTier: null,
  } as never);
  const out = new Map<string, string[] | null>();
  for (const tool of tools) {
    // biome-ignore lint/suspicious/noExplicitAny: zod's runtime shape isn't typed in public API
    let def: any = (tool.inputSchema as z.ZodTypeAny)._def;
    while (def?.typeName === "ZodEffects") def = def.schema?._def;
    const shape = typeof def?.shape === "function" ? def.shape() : def?.shape;
    out.set(tool.name, def?.typeName === "ZodObject" && shape ? Object.keys(shape) : null);
  }
  return out;
}

const SIGNATURE = /`([a-z][a-z0-9_]+)\(([^`()]*)\)`/g;

/**
 * The argument names a written signature claims. A quoted value
 * (`read_skill("video")`) and `...` name nothing. `{a, b?}` is read as its
 * fields, `async:true` and `id: "x"` as the name before the colon.
 */
function namedArguments(list: string): string[] {
  return list
    .replace(/[{}]/g, "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && part !== "..." && !/^\\?["'`$]/.test(part))
    .map((part) =>
      part
        .split(/[:=]/)[0]!
        .trim()
        .replace(/(\?|\[\])+$/, ""),
    )
    .filter((name) => /^[a-z_][a-z0-9_]*$/i.test(name));
}

type Written = { file: string; tool: string; signature: string; unknown: string[] };

/** Source files, and the skills in the repository: a private skill is not this test's to judge. */
function promptFiles(): string[] {
  const files: string[] = [];
  for (const dir of ["src", "integrations"]) {
    for (const path of new Glob("**/*.ts").scanSync({ cwd: join(ROOT, dir), absolute: true })) {
      if (!path.includes("/node_modules/") && !path.includes("/test/")) files.push(path);
    }
  }
  const tracked = Bun.spawnSync(["git", "ls-files", "skills/**/*.md"], { cwd: ROOT });
  for (const line of tracked.stdout.toString().split("\n")) {
    if (line.trim()) files.push(join(ROOT, line.trim()));
  }
  return files;
}

function writtenSignatures(args: Map<string, string[] | null>): Written[] {
  const found: Written[] = [];
  for (const path of promptFiles()) {
    for (const m of readFileSync(path, "utf8").matchAll(SIGNATURE)) {
      const shape = args.get(m[1]!);
      if (!shape) continue;
      found.push({
        file: relative(ROOT, path),
        tool: m[1]!,
        signature: m[0],
        unknown: namedArguments(m[2]!).filter((name) => !shape.includes(name)),
      });
    }
  }
  return found;
}

describe("a tool signature written for the model", () => {
  const args = toolArguments();
  const written = writtenSignatures(args);

  test("names only arguments the tool has", () => {
    const wrong = written
      .filter((w) => w.unknown.length > 0)
      .map((w) => `${w.file}: ${w.signature} has no ${w.unknown.join(", ")}`);
    expect(wrong).toEqual([]);
  });

  // The check above passes on nothing: hold it to what it has to have read.
  test("is found where the system prompt lists the tools", () => {
    expect(args.size).toBeGreaterThan(60);
    expect(written.length).toBeGreaterThan(60);
    const inPrompt = written.filter((w) => w.file === "src/model/system-prompt.ts");
    const byTool = new Map(inPrompt.map((w) => [w.tool, w.signature]));
    expect(byTool.get("react")).toBe("`react(reaction, target?, target_guid?)`");
    expect(byTool.has("message_contact")).toBe(true);
    expect(byTool.has("generate_video")).toBe(true);
    expect(written.some((w) => w.file.startsWith("skills/"))).toBe(true);
  });

  test("is read for its argument names, whatever the notation", () => {
    expect(namedArguments("reaction, target?, target_guid?")).toEqual([
      "reaction",
      "target",
      "target_guid",
    ]);
    expect(namedArguments("url, selectors[], async:true")).toEqual(["url", "selectors", "async"]);
    expect(namedArguments("{enabled, active_hours?}")).toEqual(["enabled", "active_hours"]);
    expect(namedArguments('id: "agent_1"')).toEqual(["id"]);
    expect(namedArguments('"AGENTS.md"|"SOUL.md"')).toEqual([]);
    expect(namedArguments("task, role?, ...")).toEqual(["task", "role"]);
    expect(namedArguments("")).toEqual([]);
  });
});
