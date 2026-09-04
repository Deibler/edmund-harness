import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Reject paths that no MCP tool should ever touch, even by accident.
 *
 * The threat model here is "the model picks the wrong path", not "the
 * model is adversarial" — Claude Code already gives it Read/Write/Bash,
 * so a true denylist is impossible. This guard just prevents the
 * obvious accidents:
 *
 *   - sending a credential file as an iMessage attachment
 *   - reading the daemon's own SQLite state to "look something up"
 *   - touching keychain / SSH / GPG material
 *
 * Returns the canonical absolute path (symlink-resolved) on success.
 * Throws Error with a human-readable reason on rejection.
 *
 * Callers should `try` this and return a model-visible error so the
 * model can pick a different path rather than retry blindly.
 */
const HOME = homedir();
const DENY_PREFIXES = [
  join(HOME, ".ssh"),
  join(HOME, ".aws"),
  join(HOME, ".gnupg"),
  join(HOME, ".config", "gh"),
  join(HOME, "Library", "Keychains"),
  join(HOME, "Library", "Cookies"),
  "/etc",
  "/private/etc",
  "/var/db",
];
const DENY_BASENAMES = new Set([
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "config.toml",
  ".env",
  ".env.local",
]);

export function assertPathSafe(inputPath: string): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("path must be a non-empty string");
  }
  // Resolve relative paths against cwd, then collapse symlinks.
  const absolute = resolve(inputPath);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    // File may not exist yet (e.g. tool is about to create it). Fall
    // back to the resolved-but-not-canonicalized path for the check —
    // the denylist still catches the obvious cases.
    canonical = absolute;
  }
  for (const prefix of DENY_PREFIXES) {
    if (canonical === prefix || canonical.startsWith(`${prefix}/`)) {
      throw new Error(`refusing path inside ${prefix}: ${canonical}`);
    }
  }
  const base = canonical.split("/").pop() ?? "";
  if (DENY_BASENAMES.has(base)) {
    throw new Error(`refusing to touch sensitive filename: ${base}`);
  }
  return canonical;
}
