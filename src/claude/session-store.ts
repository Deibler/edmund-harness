import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Claude Code writes conversation jsonl to `~/.claude/projects/<encoded>/`,
 * where `<encoded>` is the cwd path with every non-alphanumeric character
 * replaced by `-`. We don't want those transcripts living in the user's
 * home — for the harness they belong alongside the rest of the persona data
 * (so backups cover them and they can be reviewed per-session).
 *
 * Strategy: for each spawn, make sure `~/.claude/projects/<encoded>` is a
 * symlink into `persona/sessions/<encoded>/`. If Claude has already created
 * a real dir there, migrate the contents before swapping.
 */

const HOME_PROJECTS = join(homedir(), ".claude", "projects");

export function ensureSessionLink(
  sandboxCwd: string,
  sessionsRoot: string,
  homeProjects: string = HOME_PROJECTS,
): void {
  mkdirSync(sessionsRoot, { recursive: true });
  const logical = resolve(sandboxCwd);
  const target = join(sessionsRoot, encodeProjectDir(logical));
  mkdirSync(target, { recursive: true });
  mkdirSync(homeProjects, { recursive: true });

  // Claude Code names the folder after the cwd it sees, which is the
  // symlink-resolved path. When the sandbox lives on another disk behind a
  // symlink that name differs from the logical one, so both lead to the
  // same transcripts; otherwise a resume finds nothing and starts afresh.
  const names = new Set([encodeProjectDir(logical)]);
  try {
    names.add(encodeProjectDir(realpathSync(logical)));
  } catch {
    // Sandbox not created yet; the next spawn adds the resolved name.
  }
  for (const name of names) linkTo(join(homeProjects, name), target);
}

function linkTo(link: string, target: string): void {
  if (!existsSync(link)) {
    try {
      lstatSync(link);
    } catch {
      symlinkSync(target, link, "dir");
      return;
    }
  }

  const stats = lstatSync(link);
  if (stats.isSymbolicLink()) return; // Already pointing somewhere; trust it.

  // It's a real directory Claude created before we set up the link. Migrate
  // its contents into the persona sessions dir, then swap the dir for a link.
  for (const entry of readdirSync(link)) {
    const from = join(link, entry);
    const to = join(target, entry);
    if (existsSync(to)) continue; // Don't clobber anything already in target.
    renameSync(from, to);
  }
  try {
    rmdirSync(link);
  } catch {
    // Non-empty leftovers (e.g. files we couldn't move) — leave the dir in
    // place and skip the symlink. Better to keep real data than to silently
    // lose it.
    return;
  }
  symlinkSync(target, link, "dir");
}

export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}
