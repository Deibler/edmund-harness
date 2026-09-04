/**
 * Wraps `scripts/launchd/service.sh` — never shells `exec`, always execFile
 * with a fixed argv so the `cmd` arg can't be injected into.
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { DaemonStatus } from "../types.ts";

const pExecFile = promisify(execFile);

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SERVICE_SH = resolve(REPO_ROOT, "scripts/launchd/service.sh");

export type DaemonCmd = "status" | "start" | "stop" | "restart";
export type DebugCmd = "on" | "off" | "show";

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await pExecFile("/bin/bash", [SERVICE_SH, ...args], {
      cwd: REPO_ROOT,
      timeout: 15_000,
      maxBuffer: 1 << 20,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
}

export async function control(cmd: DaemonCmd): Promise<{ ok: boolean; output: string }> {
  const { code, stdout, stderr } = await run([cmd]);
  return { ok: code === 0, output: [stdout, stderr].filter(Boolean).join("\n") };
}

export async function status(): Promise<DaemonStatus> {
  const { stdout, stderr } = await run(["status"]);
  const raw = [stdout, stderr].filter(Boolean).join("\n");
  const loaded = !/not loaded/i.test(raw);
  const pidMatch = raw.match(/pid\s*=\s*(\d+)/);
  const stateMatch = raw.match(/state\s*=\s*(\w+)/);
  const exitMatch = raw.match(/last exit code\s*=\s*(-?\d+)/);
  const debug = await readDebug();
  return {
    loaded,
    running: loaded && stateMatch?.[1] === "running",
    pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
    lastExitCode: exitMatch ? Number.parseInt(exitMatch[1], 10) : null,
    debug,
    raw,
  };
}

export async function setDebug(cmd: DebugCmd): Promise<{ ok: boolean; output: string }> {
  const { code, stdout, stderr } = await run(["debug", cmd]);
  return { ok: code === 0, output: [stdout, stderr].filter(Boolean).join("\n") };
}

async function readDebug(): Promise<"on" | "off" | "unset"> {
  const { stdout } = await run(["debug", "show"]);
  const m = stdout.match(/EDMUND_LOG_LEVEL\s*=\s*(\S+)/);
  if (!m) return "unset";
  if (m[1] === "debug") return "on";
  if (m[1] === "(unset)") return "unset";
  return "off";
}
