/**
 * The OpenRouter credential, used only for media (dish photos and speech).
 *
 * Resolved from this file's location rather than `$HOME`, so it works for
 * launchd jobs with a trimmed environment and wherever the checkout lives.
 * `EDMUND_CONFIG_PATH` overrides it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** integrations/kitchen/src -> the harness root. */
const ROOT = join(import.meta.dir, "..", "..", "..");

function configPath(): string {
  return process.env.EDMUND_CONFIG_PATH || join(ROOT, "config.toml");
}

export function openrouterKey(): string {
  const p = configPath();
  if (!existsSync(p)) throw new Error(`no config at ${p}, so no openrouter key`);
  const m = /openrouter\s*=\s*"([^"]+)"/.exec(readFileSync(p, "utf8"));
  if (!m) throw new Error(`no openrouter key in ${p}`);
  return m[1]!;
}
