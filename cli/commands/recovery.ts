/**
 * `edmund recovery <subcmd>` — control + introspect the out-of-band
 * operator channel (edmund-911), which lives in a sibling repo at
 * ~/edmund-911. That daemon polls chat.db for "Claude ..." messages
 * from the operator handle and spawns a debug Claude session over
 * iMessage. It runs in its own launchd job so it stays available when
 * edmund-harness itself is wedged.
 *
 * Subcommands:
 *   edmund recovery logs [--follow|-f] [--err]
 *     Tail the operator log. --err switches to the stderr sidecar
 *     (uncaught exceptions, launchd respawn diagnostics).
 *
 * The recovery daemon lives outside this repo by design — keep
 * coupling to file paths only.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Parsed } from "../args.ts";
import { hasFlag } from "../args.ts";
import { color, fail, print } from "../ui.ts";

const RECOVERY_LOG = join(homedir(), "edmund-911", "data", "911.log");
const RECOVERY_ERR = join(homedir(), "edmund-911", "data", "911.err.log");

export async function recoveryCommand(p: Parsed): Promise<void> {
  const sub = p.positional[0];
  if (!sub) {
    printHelp();
    return;
  }
  switch (sub) {
    case "logs":
      return logsSub(p);
    default:
      fail(`unknown recovery subcommand: ${sub}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  print(`${color.bold("edmund recovery")} — operator channel (edmund-911) controls

${color.bold("Subcommands")}
  ${color.cyan("logs")} [--follow|-f] [--err]   tail the operator daemon log
`);
}

async function logsSub(p: Parsed): Promise<void> {
  const follow = hasFlag(p, "follow", "f");
  const path = hasFlag(p, "err") ? RECOVERY_ERR : RECOVERY_LOG;

  if (!existsSync(path)) {
    fail(`operator log not found: ${path}`);
    fail(`is the edmund-911 daemon installed? \`launchctl list | grep edmund.911\``);
    process.exit(1);
  }

  const tailArgs = follow ? ["-n", "200", "-F", path] : ["-n", "200", path];
  const child = spawn("tail", tailArgs, { stdio: ["inherit", "pipe", "inherit"] });

  let carry = "";
  child.stdout.on("data", (chunk: Buffer) => {
    carry += chunk.toString("utf8");
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) writeLine(line);
  });
  child.on("exit", (code) => {
    if (carry) writeLine(carry);
    process.exit(code ?? 0);
  });
  process.on("SIGINT", () => {
    try {
      child.kill("SIGINT");
    } catch {}
    process.exit(0);
  });
}

/**
 * The operator daemon writes lines like:
 *   [2026-05-15T14:50:50.321Z] trigger rowId=18916 from=+15550100001 ...
 * No level field — every line is essentially info-level. Colorize the
 * timestamp dim and tag specific keywords (trigger / drain / error)
 * for quick scanning.
 */
function writeLine(raw: string): void {
  if (!raw) return;
  const tsM = raw.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]\s+/);
  const ts = tsM?.[1] ? color.dim(tsM[1].slice(11, 19)) : "";
  const rest = tsM ? raw.slice(tsM[0].length) : raw;
  const tag = (() => {
    if (rest.startsWith("trigger")) return color.cyan("TRIG ");
    if (rest.startsWith("drain")) return color.green("DRAIN");
    if (/error|FAILED/i.test(rest)) return color.red("ERR  ");
    if (rest.startsWith("chat=") && /done in/.test(rest)) return color.green("OK   ");
    return color.dim("·    ");
  })();
  print([ts, tag, rest].filter(Boolean).join(" "));
}
