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
export const ISOLATED_SETTINGS_ARGS: readonly string[] = isolatedSettingsArgs();

/**
 * The settings fragment that registers the post-compaction hook
 * (post-compact-thread.ts) on a conversation worker: after every compaction,
 * automatic or manual, Claude Code runs it and adds the chat's latest
 * messages to the compacted context. It travels in the worker's own
 * `--settings` JSON because workers read no settings files, with absolute
 * paths because the worker's cwd is its sandbox.
 */
export function postCompactHookSettings(bun = process.execPath): Record<string, unknown> {
  const script = new URL("./post-compact-thread.ts", import.meta.url).pathname;
  return {
    hooks: {
      SessionStart: [
        {
          matcher: "compact",
          hooks: [{ type: "command", command: `"${bun}" "${script}"`, timeout: 15 }],
        },
      ],
    },
  };
}

/** ISOLATED_SETTINGS_ARGS with more settings in the same `--settings` JSON,
 *  such as the conversation worker's post-compaction hook. */
export function isolatedSettingsArgs(extra: Record<string, unknown> = {}): string[] {
  return [
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ autoMemoryEnabled: false, alwaysThinkingEnabled: true, ...extra }),
  ];
}

/**
 * For any spawn that may be resumed. Since about CLI 2.1.287 a conversation
 * records its system prompt on the first request and resends that record on
 * every resume, ignoring the --append-system-prompt it is given, until the
 * conversation compacts. The prompt carries the person file, SOUL.md and the
 * session's loadout text, so a resumed turn ran on memory as old as the last
 * compaction: over 7 days (2,330 turns, measured 2026-10-23) the median was
 * 1.7 h old, the 75th percentile 13.6 h, and 13% of turns saw a prompt more
 * than a day old. Off, a resume renders the prompt it is given, as every
 * spawn did before snapshots. An unchanged prompt still reads from cache.
 */
export const PROMPT_SNAPSHOT_ARGS: readonly string[] = ["--system-prompt-snapshot", "off"];

export function directClaudeEnv(
  overrides: Record<string, string> = {},
  access: HostAccess = "full",
): Record<string, string> {
  const inherited = Object.entries(process.env as Record<string, string>).filter(
    ([key]) => !ALWAYS_STRIPPED.has(key) && (access === "full" || envAllowedWhenSandboxed(key)),
  );
  return Object.fromEntries([...inherited, ...Object.entries(overrides)]);
}
