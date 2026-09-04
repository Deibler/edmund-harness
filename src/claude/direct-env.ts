/**
 * Environment for Claude Code and Codex subprocesses.
 *
 * Two things happen here. The two variables used by a retired local gateway
 * are always stripped, so a manually started daemon cannot inherit stale
 * proxy routing from an older shell. And under sandboxed host access the
 * worker gets an allowlisted environment rather than the daemon's whole one:
 * the daemon holds Twilio credentials and whatever else the operator's shell
 * exported, and a worker that cannot run shell commands has no use for them.
 * Under full host access the environment is inherited as before.
 */

import type { HostAccess } from "../security/policy.ts";
import { envAllowedWhenSandboxed } from "../security/policy.ts";

const ALWAYS_STRIPPED = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"]);

export function directClaudeEnv(
  overrides: Record<string, string> = {},
  access: HostAccess = "full",
): Record<string, string> {
  const inherited = Object.entries(process.env as Record<string, string>).filter(
    ([key]) => !ALWAYS_STRIPPED.has(key) && (access === "full" || envAllowedWhenSandboxed(key)),
  );
  return Object.fromEntries([...inherited, ...Object.entries(overrides)]);
}
