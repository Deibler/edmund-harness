/**
 * A command that stops or starts the assistant does what was typed or
 * nothing.
 *
 * `edmund restart --help` restarted all four services on 2026-11-25, with a
 * conversation in flight: the CLI's help says `--help` gives per-command
 * help, and these commands never looked for it or for anything else they did
 * not know. `edmund restart harness`, missing its dashes, restarted
 * everything too.
 *
 * Nothing here runs the CLI: with the guard gone, running it would restart
 * the machine's own services.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../cli/args.ts";
import { resolveTargets, serviceCommandRefusal } from "../cli/services/target.ts";

const typed = (cmd: string, ...argv: string[]) => serviceCommandRefusal(cmd, parse(argv));

describe("a service command", () => {
  test("asked for help, prints its usage and does nothing", () => {
    for (const cmd of ["start", "stop", "restart", "status", "kill"]) {
      for (const flag of ["--help", "-h"]) {
        const r = typed(cmd, flag);
        expect(r?.help).toBe(true);
        expect(r?.text).toContain(`usage: edmund ${cmd} [--harness] [--dashboard] [--fishing]`);
      }
    }
    expect(typed("start", "--help")?.text).toContain("[--local]");
    expect(typed("restart", "--harness", "--help")?.help).toBe(true);
  });

  test("refuses a flag it does not have", () => {
    const r = typed("restart", "--harnes");
    expect(r?.help).toBe(false);
    expect(r?.text).toContain("edmund restart has no flag --harnes, so nothing was done.");
    expect(typed("stop", "--local")?.text).toContain("no flag --local");
    expect(typed("kill", "-f")?.text).toContain("no flag -f");
  });

  test("refuses a service named without its dashes, which used to mean all of them", () => {
    const r = typed("restart", "harness");
    expect(r?.text).toContain('no use for "harness"');
    expect(r?.text).toContain("so nothing was done");
    // The parser reads the word after a flag as its value.
    expect(typed("restart", "--harness", "dashboard")?.text).toContain('no use for "dashboard"');
    expect(resolveTargets(parse(["harness"]))).toEqual(["harness", "dashboard", "fishing"]);
  });

  test("runs as typed when every flag is one it takes", () => {
    expect(typed("restart")).toBeNull();
    expect(typed("restart", "--harness")).toBeNull();
    expect(typed("stop", "--dashboard", "--fishing")).toBeNull();
    expect(typed("start", "--harness", "--local")).toBeNull();
    expect(typed("status")).toBeNull();
  });

  test("is the only kind this holds: other commands read their own arguments", () => {
    expect(typed("logs", "--follow")).toBeNull();
    expect(typed("cron", "delete", "job_1")).toBeNull();
  });

  test("is checked before any command is dispatched", () => {
    const main = readFileSync(join(import.meta.dir, "../cli/main.ts"), "utf8");
    const guard = main.indexOf("const refusal = serviceCommandRefusal(cmd, p);");
    const acted = main.indexOf("if (refusal) {");
    const dispatch = main.indexOf("switch (cmd) {");
    expect(guard).toBeGreaterThan(0);
    expect(acted).toBeGreaterThan(guard);
    expect(dispatch).toBeGreaterThan(acted);
    expect(main.slice(acted, dispatch)).toContain("return;");
  });
});
