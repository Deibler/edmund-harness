/**
 * Move a data folder from the old flat layout to the grouped one, and its
 * logs out to the logs folder.
 *
 * Run once, with the services stopped (`edmund data migrate --apply`). It is
 * a set of renames on one disk: nothing is copied, nothing is overwritten,
 * and running it again finds nothing left to do.
 *
 * Two rules keep it from making things worse than untidy. A database that
 * any process has open stops the whole migration before anything moves: a
 * process that keeps writing to a file after it has gone from the path, while
 * the next one opens the path fresh, is two copies of the state. And a target
 * that already exists is a conflict to be looked at, never replaced.
 *
 * A log that another program still has open (a tunnel that was not
 * restarted) is left where it is and reported: that program looks for the
 * file by its old name until it restarts.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { GROUP_FOLDERS, movedTo } from "./data-layout.ts";

type Move = { from: string; to: string; database: boolean; log: boolean };

export type MigrationPlan = {
  moves: Move[];
  /** A source whose destination already exists. */
  conflicts: { from: string; to: string }[];
};

const isDatabase = (name: string): boolean => /\.(db|sqlite)(-wal|-shm)?$/.test(name);

/** The names at the top of a data folder that belong to the old layout. */
function oldLayoutNames(dataDir: string): string[] {
  try {
    return readdirSync(dataDir).filter(
      (name) => movedTo(name) !== null || name === "logs" || name.endsWith(".log"),
    );
  } catch {
    return [];
  }
}

/**
 * Databases still at the top of the data folder. A daemon that opened its
 * databases in `db/` while these sat here would start from empty ones.
 */
export function unmigratedDatabases(dataDir: string): string[] {
  return oldLayoutNames(dataDir).filter(
    (name) => isDatabase(name) && !/-(wal|shm)$/.test(name) && movedTo(name) !== null,
  );
}

export function planMigration(dataDir: string, logsDir: string): MigrationPlan {
  const plan: MigrationPlan = { moves: [], conflicts: [] };
  const add = (from: string, to: string, flags: { database?: boolean; log?: boolean } = {}) => {
    if (!existsSync(from)) return;
    if (existsSync(to)) {
      plan.conflicts.push({ from, to });
      return;
    }
    plan.moves.push({ from, to, database: flags.database ?? false, log: flags.log ?? false });
  };
  /** True for a folder that exists, or will once the moves planned so far are done. */
  const willExist = (dir: string): boolean =>
    existsSync(dir) || plan.moves.some((m) => m.to === dir || m.to.startsWith(`${dir}/`));
  /** Move a folder; when the destination exists, move what is inside it instead. */
  const addFolder = (from: string, to: string, log: boolean) => {
    if (!existsSync(from)) return;
    if (!willExist(to)) {
      plan.moves.push({ from, to, database: false, log });
      return;
    }
    for (const child of readdirSync(from)) {
      const source = join(from, child);
      if (statSync(source).isDirectory()) addFolder(source, join(to, child), log);
      else add(source, join(to, child), { log });
    }
  };

  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return plan;
  }
  for (const name of names.sort()) {
    const from = join(dataDir, name);
    const isFolder = statSync(from).isDirectory();
    const target = movedTo(name);
    if (target) {
      if (isFolder) addFolder(from, join(dataDir, target), false);
      else add(from, join(dataDir, target), { database: isDatabase(name) });
      continue;
    }
    if (name === "logs" && isFolder) {
      // The channels, the earlier days and the archive, each to the same name
      // under logs/. Never the folder as a whole: the operational log moves
      // there too, so the destination exists by the time this would run.
      for (const child of readdirSync(from)) {
        const source = join(from, child);
        if (statSync(source).isDirectory()) addFolder(source, join(logsDir, child), true);
        else add(source, join(logsDir, child), { log: true });
      }
    } else if (name === "daemon.log" || name === "dashboard.log") {
      add(from, join(logsDir, name), { log: true });
    } else if (!isFolder && name.endsWith(".log")) {
      add(from, join(logsDir, "services", name), { log: true });
    }
  }
  return plan;
}

export type MigrationResult = {
  moved: Move[];
  /** Left in place, with the reason. */
  left: { path: string; reason: string }[];
  /** Set when nothing was moved at all. */
  refused?: string;
};

/**
 * Carry out a plan. `inUse` names the command holding a path open, or null;
 * asked with `true`, only a command that has it open for writing.
 * `force` moves databases even when one is open, for a caller that has
 * stopped everything and knows the holder is a reader that will follow.
 */
export function applyMigration(
  plan: MigrationPlan,
  inUse: (path: string, writersOnly?: boolean) => string | null,
  force = false,
): MigrationResult {
  const result: MigrationResult = { moved: [], left: [] };
  if (!force) {
    for (const move of plan.moves) {
      if (!move.database) continue;
      const holder = inUse(move.from);
      if (holder) {
        result.refused = `${move.from} is open in ${holder}. Stop the daemon, the dashboard and anything else using the data folder, then run this again.`;
        return result;
      }
    }
  }
  for (const move of plan.moves) {
    if (move.log) {
      // A log matters only to whoever is writing it: a reader follows nothing.
      const holder = statSync(move.from).isDirectory() ? null : inUse(move.from, true);
      if (holder) {
        result.left.push({
          path: move.from,
          reason: `still written by ${holder}; it moves once that restarts`,
        });
        continue;
      }
    }
    try {
      mkdirSync(dirname(move.to), { recursive: true, mode: 0o700 });
      renameSync(move.from, move.to);
      result.moved.push(move);
    } catch (err) {
      result.left.push({ path: move.from, reason: (err as Error).message });
    }
  }
  return result;
}

/** Make the folders the layout names, and remove an old `logs` folder that is now empty. */
/**
 * Refuse to start on a data folder that still has its databases at the top.
 * Opening them where they now belong would find nothing there and start from
 * empty state beside the real one.
 */
function assertMigrated(dataDir: string): void {
  const left = unmigratedDatabases(dataDir);
  if (left.length === 0) return;
  throw new Error(
    `${dataDir} is in the old layout (${left.slice(0, 3).join(", ")}${left.length > 3 ? ", …" : ""} at the top). Stop every harness service and run: edmund data migrate --apply`,
  );
}

/**
 * What a service does with the data folder before it opens anything in it:
 * refuse one in the old layout, and make the group folders, so that no writer
 * has to wonder whether its folder exists.
 */
export function prepareDataFolder(dataDir: string): void {
  assertMigrated(dataDir);
  for (const group of GROUP_FOLDERS) {
    mkdirSync(join(dataDir, group), { recursive: true, mode: 0o700 });
  }
}

export function finishMigration(dataDir: string, logsDir: string): void {
  for (const group of GROUP_FOLDERS)
    mkdirSync(join(dataDir, group), { recursive: true, mode: 0o700 });
  mkdirSync(join(logsDir, "services"), { recursive: true, mode: 0o700 });
  const removeIfEmpty = (dir: string) => {
    try {
      for (const child of readdirSync(dir)) {
        const path = join(dir, child);
        if (statSync(path).isDirectory()) removeIfEmpty(path);
      }
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {}
  };
  if (existsSync(join(dataDir, "logs"))) removeIfEmpty(join(dataDir, "logs"));
}
