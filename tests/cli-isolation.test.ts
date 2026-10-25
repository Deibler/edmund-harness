/**
 * Every Claude Code process the harness starts reads no setting source. On
 * 2026-10-23 each cold Edmund turn carried about 25k tokens of the operator's
 * CLAUDE.md files, auto-memory and plugin skills, and every one-shot (ghost,
 * pre-screen, maintainer, curator, catch-up) also had all built-in tools and
 * the operator's MCP servers and claude.ai connectors while reading text
 * other people wrote.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISOLATED_SETTINGS_ARGS, PROMPT_SNAPSHOT_ARGS } from "../src/claude/direct-env.ts";
import { oneShotArgv, runClaudeOneShot } from "../src/claude/one-shot.ts";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the isolation flags", () => {
  test("no setting source; memory off, thinking on", () => {
    const i = ISOLATED_SETTINGS_ARGS.indexOf("--setting-sources");
    expect(ISOLATED_SETTINGS_ARGS[i + 1]).toBe("");
    const settings = JSON.parse(
      ISOLATED_SETTINGS_ARGS[ISOLATED_SETTINGS_ARGS.indexOf("--settings") + 1]!,
    );
    expect(settings).toEqual({ autoMemoryEnabled: false, alwaysThinkingEnabled: true });
  });
});

describe("oneShotArgv", () => {
  const base = ["--model", "claude-haiku-5-5", "--append-system-prompt", "x"];
  const toolsArg = (argv: string[]) =>
    argv.flatMap((a, i) => (a === "--tools" ? [argv[i + 1]] : []));

  test("a text-only call gets no tools, no foreign MCP servers, no transcript", () => {
    const argv = oneShotArgv(base);
    expect(argv.join("\u0000")).toContain(ISOLATED_SETTINGS_ARGS.join("\u0000"));
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--no-session-persistence");
    expect(toolsArg(argv)).toEqual([""]);
    expect(argv.slice(-base.length)).toEqual(base);
  });

  test("a caller that names its tools gets exactly those", () => {
    expect(toolsArg(oneShotArgv([...base, "--tools", "Read"]))).toEqual(["Read"]);
  });

  test("effort comes from the harness config unless the caller names one", () => {
    const effortArg = (argv: string[]) =>
      argv.flatMap((a, i) => (a === "--effort" ? [argv[i + 1]] : []));
    expect(effortArg(oneShotArgv(base, "xhigh"))).toEqual(["xhigh"]);
    expect(effortArg(oneShotArgv([...base, "--effort", "low"], "xhigh"))).toEqual(["low"]);
    expect(effortArg(oneShotArgv(base, undefined))).toEqual([]);
  });

  test("satellite calls never inherit the turn effort", () => {
    const effortArg = (argv: string[]) =>
      argv.flatMap((a, i) => (a === "--effort" ? [argv[i + 1]] : []));
    const saved = { turn: process.env.EDMUND_EFFORT, bg: process.env.EDMUND_BACKGROUND_EFFORT };
    try {
      process.env.EDMUND_EFFORT = "xhigh";
      delete process.env.EDMUND_BACKGROUND_EFFORT;
      expect(effortArg(oneShotArgv(base))).toEqual([]);
      process.env.EDMUND_BACKGROUND_EFFORT = "low";
      expect(effortArg(oneShotArgv(base))).toEqual(["low"]);
    } finally {
      if (saved.turn === undefined) delete process.env.EDMUND_EFFORT;
      else process.env.EDMUND_EFFORT = saved.turn;
      if (saved.bg === undefined) delete process.env.EDMUND_BACKGROUND_EFFORT;
      else process.env.EDMUND_BACKGROUND_EFFORT = saved.bg;
    }
  });

  test("a caller with its own MCP config keeps its tool choice", () => {
    const argv = oneShotArgv([...base, "--mcp-config", "{}", "--strict-mcp-config"]);
    expect(toolsArg(argv)).toEqual([]);
    expect(argv.filter((a) => a === "--strict-mcp-config")).toHaveLength(1);
  });
});

describe("runClaudeOneShot spawns what oneShotArgv builds", () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-claude-argv-"));
  const cwd = mkdtempSync(join(tmpdir(), "one-shot-cwd-"));
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" -e 'console.log(JSON.stringify({type:"result",result:JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd()})}))' -- "$@"\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  afterAll(() => {
    rmSync(bin, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("argv and cwd reach the process", async () => {
    const args = ["--model", "claude-haiku-5-5"];
    const r = await runClaudeOneShot({
      args,
      input: "",
      timeoutMs: 10_000,
      env: { PATH: `${bin}:${process.env.PATH}` },
      cwd,
    });
    expect(r.ok).toBe(true);
    const seen = JSON.parse(r.text) as { argv: string[]; cwd: string };
    expect(seen.argv.slice(-oneShotArgv(args).length)).toEqual(oneShotArgv(args));
    expect(seen.cwd.endsWith(cwd.split("/").pop()!)).toBe(true);
  });
});

describe("every Claude spawn site is isolated", () => {
  test("the turn worker and the sub-agent runner pass the flags", () => {
    // The pool's workers get runClaude's argv, so baseArgs covers both paths.
    const runner = read("src/claude/runner.ts");
    const baseArgs = runner.slice(runner.indexOf("const baseArgs"), runner.indexOf("const env ="));
    expect(baseArgs).toContain("...ISOLATED_SETTINGS_ARGS,");
    expect(read("scripts/agent-runner.ts")).toContain("...ISOLATED_SETTINGS_ARGS,");
    expect(read("src/claude/one-shot.ts")).toContain('spawn("claude", oneShotArgv(opts.args)');
  });

  test("a resumed turn renders the prompt it is given", () => {
    // With the CLI's default snapshot, a resume resent the prompt the
    // conversation first recorded: SOUL.md and the person file as of the last
    // compaction (a day or more old on 13% of turns, 2026-10-23).
    expect(PROMPT_SNAPSHOT_ARGS).toEqual(["--system-prompt-snapshot", "off"]);
    const runner = read("src/claude/runner.ts");
    const baseArgs = runner.slice(runner.indexOf("const baseArgs"), runner.indexOf("const env ="));
    expect(baseArgs).toContain("...PROMPT_SNAPSHOT_ARGS,");
  });

  test("no other file starts the claude binary", () => {
    const sites: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && /spawn\([^,]*"claude"\s*,/.test(read(p))) sites.push(p);
      }
    };
    walk("src");
    walk("scripts");
    // runner.ts spawns baseArgs (spawn-per-turn); worker.ts spawns the argv
    // runner.ts hands the pool. A new site has to be added here on purpose.
    expect(sites.sort()).toEqual([
      "scripts/agent-runner.ts",
      "src/claude/one-shot.ts",
      "src/claude/runner.ts",
      "src/claude/worker.ts",
    ]);
  });
});
