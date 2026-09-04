/**
 * `edmund install` — symlink bin/edmund into /opt/homebrew/bin (or /usr/local/bin)
 * so the CLI is on PATH without shell edits.
 *
 * Idempotent: re-running replaces a stale symlink in place. Refuses to touch
 * a non-symlink target (that would imply a real file you wrote yourself).
 */

import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Parsed } from "../args.ts";
import { REPO } from "../services/paths.ts";
import { color, fail, info, ok, print, section } from "../ui.ts";

const CANDIDATES = ["/opt/homebrew/bin", "/usr/local/bin"];

export async function installCommand(_p: Parsed): Promise<void> {
  const src = resolve(REPO, "bin/edmund");
  if (!existsSync(src)) {
    fail(`source not found: ${src}`);
    process.exit(1);
  }
  const target = pickDir();
  if (!target) {
    fail("no writable install directory found.");
    info(`tried: ${CANDIDATES.join(", ")}`);
    process.exit(1);
  }
  const dest = resolve(target, "edmund");
  section("install");
  info(`source: ${color.dim(src)}`);
  info(`dest:   ${color.dim(dest)}`);

  if (existsSync(dest)) {
    const lst = lstatSync(dest);
    if (!lst.isSymbolicLink()) {
      fail(`${dest} exists and is not a symlink — refusing to overwrite.`);
      process.exit(1);
    }
    const cur = readlinkSync(dest);
    if (cur === src) {
      ok("already installed — symlink is up to date.");
      return;
    }
    unlinkSync(dest);
  }
  symlinkSync(src, dest);
  ok(`symlinked — you can now run ${color.cyan("edmund")} from any shell.`);
  print("");
  info(`try:  ${color.cyan("edmund status")}`);
}

function pickDir(): string | null {
  for (const d of CANDIDATES) {
    try {
      if (existsSync(d) && isWritable(d)) return d;
    } catch {}
  }
  return null;
}

function isWritable(dir: string): boolean {
  try {
    const probe = resolve(dir, `.edmund-write-probe-${process.pid}`);
    symlinkSync("/dev/null", probe);
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
