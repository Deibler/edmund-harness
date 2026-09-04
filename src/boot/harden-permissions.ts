/**
 * File permissions for everything the harness writes.
 *
 * The data directory holds every database, the logs, the dashboard secret
 * and tunnel tokens; the persona directory holds real people's details;
 * config.toml and .env hold API keys. None of it should be readable by
 * another account on the Mac. The daemon and the dashboard both call this at
 * boot: set a private umask so new files are born 0600, then sweep what
 * already exists. Best effort, never fatal: a permission error on one file
 * is logged and the boot continues.
 */

import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type HardenReport = { dirs: number; files: number; errors: string[] };

const SENSITIVE_FILE =
  /\.(db|db-wal|db-shm|sqlite|sqlite-wal|sqlite-shm|log|jsonl|json|secret|token|toml|bak.*)$|^(\.env|dashboard\.secret|sms-tunnel-token|portal-tunnel-url)$/;

function setPrivateUmask(): void {
  try {
    process.umask(0o077);
  } catch {
    // Not every runtime exposes umask; the sweep below still runs.
  }
}

/**
 * Tighten `dirs` to 0700 and the sensitive files directly inside them to
 * 0600. Only the top level of each directory is swept: the data dir is flat
 * where it matters, and a recursive chmod over a sandbox full of media on
 * every boot is not worth the I/O.
 */
export function hardenPaths(dirs: string[], files: string[] = []): HardenReport {
  const report: HardenReport = { dirs: 0, files: 0, errors: [] };
  const chmod = (p: string, mode: number, kind: "dirs" | "files") => {
    try {
      const st = statSync(p);
      if ((st.mode & 0o777) !== mode) chmodSync(p, mode);
      report[kind]++;
    } catch (err) {
      report.errors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    chmod(dir, DIR_MODE, "dirs");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch (err) {
      report.errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const name of names) {
      if (!SENSITIVE_FILE.test(name)) continue;
      const p = join(dir, name);
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      chmod(p, FILE_MODE, "files");
    }
  }
  for (const f of files) {
    if (existsSync(f)) chmod(f, FILE_MODE, "files");
  }
  return report;
}

/** The standard call for a process rooted at `repoRoot` with this data dir. */
export function hardenHarnessPermissions(repoRoot: string, dataDir: string): HardenReport {
  setPrivateUmask();
  const report = hardenPaths(
    [dataDir, join(repoRoot, "persona"), join(repoRoot, "sandbox")],
    [join(repoRoot, "config.toml"), join(repoRoot, ".env")],
  );
  for (const name of safeReaddir(repoRoot)) {
    if (name.startsWith("config.toml.bak")) hardenPaths([], [join(repoRoot, name)]);
  }
  return report;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
