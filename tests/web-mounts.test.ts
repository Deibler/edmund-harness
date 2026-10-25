import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountFor, readMounts, registerMount, unregisterMount } from "../src/web/mounts.ts";

const dir = mkdtempSync(join(tmpdir(), "web-mounts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("path mounts on the public host", () => {
  test("a registered prefix routes to its port, nothing else does", () => {
    registerMount(dir, "/print/", 41234);
    expect(mountFor(dir, "/print/abc/status.json")).toBe(41234);
    expect(mountFor(dir, "/shelf/abc/")).toBeNull();
    expect(mountFor(dir, "/printer")).toBeNull();
  });

  test("bad prefixes are refused, and a hand-edited bad entry is ignored", () => {
    expect(() => registerMount(dir, "/../", 1)).toThrow();
    expect(() => registerMount(dir, "print", 1)).toThrow();
    writeFileSync(join(dir, "web-mounts.json"), JSON.stringify({ "/": 9, "/ok/": 2, "/x/": "no" }));
    expect(readMounts(dir)).toEqual({ "/ok/": 2 });
  });

  test("unregistering removes only that prefix", () => {
    registerMount(dir, "/print/", 41234);
    unregisterMount(dir, "/print/");
    expect(readMounts(dir)).toEqual({ "/ok/": 2 });
  });

  test("the kitchen host consults mounts before kitchen routes", () => {
    const host = readFileSync(
      join(import.meta.dir, "..", "integrations/kitchen/scripts/host.ts"),
      "utf8",
    );
    expect(host.indexOf("mountFor(mountsDir")).toBeGreaterThan(host.indexOf("serveShelf(req"));
    expect(host.indexOf("mountFor(mountsDir")).toBeLessThan(host.indexOf("route(url, current)"));
  });
});

describe("a skill's references are reachable", () => {
  test("read_skill lists them as absolute paths", async () => {
    const { referencesFooter } = await import("../src/mcp/tools/skills.ts");
    const footer = referencesFooter(join(import.meta.dir, "..", "skills", "printing"));
    expect(footer).toContain("/skills/printing/references/settings.md");
    expect(footer).toContain("/skills/printing/references/preview.md");
    expect(referencesFooter(join(import.meta.dir, "..", "skills", "video"))).toBe("");
  });
});
