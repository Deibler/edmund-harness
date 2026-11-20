import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { builderTask } from "../src/ideation/build.ts";
import type { Ideation } from "../src/ideation/store.ts";

/**
 * The builder is told where its template, design skill and publish script
 * are by absolute path, in prose. A path that stops existing fails every
 * build at once and silently, so each one is checked here.
 */
const row: Ideation = {
  id: "0123456789abcdef0123456789abcdef",
  sessionKey: "imessage:dm:+15550100001",
  thread: "the night sky",
  threadKey: "the night sky",
  title: "Sky Clock",
  pitch: "When the light is good tonight.",
  why: "Asked on three days.",
  brief: "One centerpiece. Leave out: everything else.",
  evidence: [1, 2, 3],
  days: ["2026-10-24", "2026-10-27", "2026-11-01"],
  status: "building",
  agentId: null,
  failReason: null,
  createdMs: 1,
  readyMs: null,
  announcedMs: null,
  deliveredMs: null,
  firstOpenMs: null,
  opens: 0,
  url: null,
};

/** The one absolute path the pattern captures, or a failed test. */
function pathIn(text: string, pattern: RegExp): string {
  const found = text.match(pattern)?.[1];
  expect(found).toBeDefined();
  expect(found?.startsWith("/")).toBe(true);
  return found as string;
}

describe("builderTask", () => {
  const task = builderTask(row, "Sam");
  const template = () => pathIn(task, /rsync -a [^"]*"(\/[^"]+ideation-template)\/"/);
  const skill = () => pathIn(task, /Read (\/\S+\/skills\/unslop)\/SKILL\.md/);
  const publish = () => pathIn(task, /bun "(\/[^"]+ideation-publish\.ts)"/);

  test("names the template, the design skill and the publish script, and each exists", () => {
    expect(existsSync(join(template(), "DESIGN.md"))).toBe(true);
    expect(existsSync(join(skill(), "SKILL.md"))).toBe(true);
    expect(existsSync(join(skill(), "references", "signs.md"))).toBe(true);
    expect(existsSync(publish())).toBe(true);
  });

  test("the design skill keeps its license and its credit", () => {
    expect(readFileSync(join(skill(), "LICENSE"), "utf8")).toContain(
      "Attribution 4.0 International",
    );
    expect(readFileSync(join(skill(), "SKILL.md"), "utf8")).toContain("Damir Sokolovsky");
  });

  test("DESIGN.md carries the overrides for building with nobody to ask", () => {
    const design = readFileSync(join(template(), "DESIGN.md"), "utf8");
    expect(design).toContain("skills/unslop/");
    expect(design).toContain("No image generation");
    expect(design).toContain("Do not run its scripts");
    expect(design).toContain("this file wins");
  });

  test("tells the builder to message nobody", () => {
    expect(task).toContain("Do not message anyone");
  });
});
