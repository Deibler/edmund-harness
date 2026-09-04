/**
 * The OpenRouter credential, in one place.
 *
 * Five modules had their own copy of this function, each reading
 * `$HOME/edmund-harness/config.toml` with its own regex. Five copies of a
 * credential reader is five places to fix when the key moves, and the `$HOME`
 * assumption is wrong for anything not launched from this user's shell — a
 * launchd job with a trimmed environment resolved it to `/config.toml` and
 * reported "no openrouter key" for a key that was sitting right there.
 *
 * Resolved from this file's own location instead, so it is correct wherever the
 * checkout lives and whoever runs it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** integrations/kitchen/src -> the harness root. */
const ROOT = join(import.meta.dir, "..", "..", "..");

export function configPath(): string {
  return process.env.EDMUND_CONFIG_PATH || join(ROOT, "config.toml");
}

export function openrouterKey(): string {
  const p = configPath();
  if (!existsSync(p)) throw new Error(`no config at ${p}, so no openrouter key`);
  const m = /openrouter\s*=\s*"([^"]+)"/.exec(readFileSync(p, "utf8"));
  if (!m) throw new Error(`no openrouter key in ${p}`);
  return m[1]!;
}
