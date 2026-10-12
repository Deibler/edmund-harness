/**
 * Claude Code plugins reach a worker through `--plugin-dir`. A plugin's
 * skills work through the shell, so only workers with one load them; the
 * list reaches sub-agents through the environment; and a bad path fails the
 * boot instead of every Claude turn.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginDirs } from "../src/config/config.ts";
import { pluginDirArgs, pluginDirsFromEnv } from "../src/security/policy.ts";

const base = mkdtempSync(join(tmpdir(), "plugin-dirs-"));
mkdirSync(join(base, "plugins", "good", ".claude-plugin"), { recursive: true });
writeFileSync(join(base, "plugins", "good", ".claude-plugin", "plugin.json"), '{"name":"good"}');
mkdirSync(join(base, "plugins", "empty"), { recursive: true });

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("pluginDirArgs", () => {
  test("a worker with a shell gets one --plugin-dir per plugin", () => {
    expect(pluginDirArgs(["/a", "/b"], "full", false)).toEqual([
      "--plugin-dir",
      "/a",
      "--plugin-dir",
      "/b",
    ]);
  });

  test("sandboxed and guest workers get none", () => {
    expect(pluginDirArgs(["/a"], "sandboxed", false)).toEqual([]);
    expect(pluginDirArgs(["/a"], "full", true)).toEqual([]);
  });
});

describe("pluginDirsFromEnv", () => {
  test("round-trips the list the daemon exports", () => {
    expect(pluginDirsFromEnv(JSON.stringify(["/a", "/b"]))).toEqual(["/a", "/b"]);
  });

  test("absent or malformed means no plugins, not a failed spawn", () => {
    expect(pluginDirsFromEnv(undefined)).toEqual([]);
    expect(pluginDirsFromEnv("not json")).toEqual([]);
    expect(pluginDirsFromEnv('{"a":1}')).toEqual([]);
  });
});

describe("resolvePluginDirs", () => {
  test("relative paths resolve against the config file's directory", () => {
    expect(resolvePluginDirs(["plugins/good"], base)).toEqual([join(base, "plugins", "good")]);
  });

  test("a directory without a plugin manifest fails at boot", () => {
    expect(() => resolvePluginDirs(["plugins/empty"], base)).toThrow(/no \.claude-plugin/);
    expect(() => resolvePluginDirs(["plugins/missing"], base)).toThrow(/no \.claude-plugin/);
  });
});
