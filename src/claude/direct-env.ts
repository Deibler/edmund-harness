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

/**
 * Settings flags for every Claude Code subprocess the harness spawns. Without
 * them a spawn reads the operator's own Claude Code setup: CLAUDE.md files
 * found walking up from the cwd (the sandboxes sit inside this checkout, so
 * the repo's developer notes and CLAUDE.local.md), ~/.claude/CLAUDE.md, the
 * auto-memory index and the user-scope plugins and MCP servers. Measured
 * 2026-10-23: about 25k tokens of that reached every cold Edmund turn, groups
 * included. No setting source is read; what the harness relies on is stated
 * here instead. Thinking was on through the operator's user settings and
 * stays on. Project settings were never read in a sandbox (the CLI looks in
 * the cwd only, not the repo root), so dropping them changes nothing.
 */
export const ISOLATED_SETTINGS_ARGS: readonly string[] = [
  "--setting-sources",
  "",
  "--settings",
  JSON.stringify({ autoMemoryEnabled: false, alwaysThinkingEnabled: true }),
];

export function directClaudeEnv(
  overrides: Record<string, string> = {},
  access: HostAccess = "full",
): Record<string, string> {
  const inherited = Object.entries(process.env as Record<string, string>).filter(
    ([key]) => !ALWAYS_STRIPPED.has(key) && (access === "full" || envAllowedWhenSandboxed(key)),
  );
  return Object.fromEntries([...inherited, ...Object.entries(overrides)]);
}
