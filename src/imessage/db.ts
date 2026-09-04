import { Database } from "bun:sqlite";

/**
 * Single read-only connection to Messages.app's chat.db. Every module that
 * reads from chat.db (watcher, history, participants, high-water mark) takes
 * an instance instead of opening its own — cuts file-handle churn and keeps
 * WAL mode uniformly applied.
 */
export class ChatDb {
  readonly db: Database;
  // Memoize prepared statements by SQL string. bun:sqlite has an LRU under
  // the hood, but ChatDb.query() goes through a wrapper layer per call and
  // the parse-and-prepare overhead is real on hot loops (history, reactions,
  // participants — multiple per turn). One Map lookup is cheaper than even a
  // cache-hit re-prepare.
  private stmtCache = new Map<
    string,
    { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown }
  >();

  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  query<T = unknown>(sql: string) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.query(sql) as {
        all: (...p: unknown[]) => unknown[];
        get: (...p: unknown[]) => unknown;
      };
      this.stmtCache.set(sql, stmt);
    }
    return stmt as {
      all: (...params: unknown[]) => T[];
      get: (...params: unknown[]) => T | undefined;
    };
  }

  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }

  /** Apple absolute time → unix ms (Apple epoch is 2001-01-01 UTC). */
  static readonly APPLE_EPOCH_MS = 978_307_200_000;
  static readonly NS_PER_MS = 1_000_000;

  static appleNsToUnixMs(ns: number): number {
    return Math.floor(ns / ChatDb.NS_PER_MS) + ChatDb.APPLE_EPOCH_MS;
  }
}
