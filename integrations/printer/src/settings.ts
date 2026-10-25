import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../../src/config/config.ts";
import { operatorHandles } from "../../../src/security/policy.ts";
import { normalizeHandle } from "../../../src/sessions/key.ts";
import { printerConfig } from "../config.ts";
import { printerDir } from "./store.ts";

/** Values the runtime and the tools both derive from config, in one place. */

export function approvers(config: Config): string[] {
  const own = printerConfig(config).approvers.map(normalizeHandle).filter(Boolean);
  return own.length ? own : operatorHandles(config);
}

export function approverName(config: Config): string {
  const own = printerConfig(config).approver_name.trim();
  if (own) return own;
  const owner = config.owner?.name?.trim() ?? "";
  return owner.split(/\s+/)[0] || "the printer's owner";
}

export function pageUrl(config: Config, token: string): string {
  const origin = (printerConfig(config).page_origin || config.shelf?.origin || "").replace(
    /\/+$/,
    "",
  );
  return origin ? `${origin}/print/${token}/` : "";
}

export function visionModel(config: Config): string {
  return printerConfig(config).vision_model || config.claude.agent_model || config.claude.model;
}

export function framesDir(dataDir: string): string {
  return join(printerDir(dataDir), "frames");
}

export function jobDir(dataDir: string, id: number): string {
  return join(printerDir(dataDir), "jobs", String(id));
}

/** Where the daemon's printer runtime says it is listening. */
export type RuntimeInfo = { port: number; secret: string; pid: number; startedMs: number };

export function runtimeInfoPath(dataDir: string): string {
  return join(printerDir(dataDir), "runtime.json");
}

export function readRuntimeInfo(dataDir: string): RuntimeInfo | null {
  const p = runtimeInfoPath(dataDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RuntimeInfo;
  } catch {
    return null;
  }
}
