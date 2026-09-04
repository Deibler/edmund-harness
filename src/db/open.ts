import { Database } from "bun:sqlite";

/**
 * Open a SQLite database hardened against the SQLITE_BUSY_RECOVERY ("database is locked")
 * crash that repeatedly killed the daemon on restart and on sleep/wake.
 *
 * Two fixes, both required:
 *   1. Arm `busy_timeout` BEFORE `journal_mode = WAL`. Entering WAL mode runs WAL recovery,
 *      and that recovery is exactly what throws under contention from another live connection
 *      (the dashboard process, or this process's other store on the same state.db). The old
 *      code set busy_timeout on the line AFTER journal_mode, so the one operation most likely
 *      to hit the lock ran with a zero timeout and crashed the whole process.
 *   2. Retry the open a few times with backoff. busy_timeout does not reliably cover
 *      BUSY_RECOVERY at open time, so a transient recovery lock (e.g. a kickstart -k SIGKILL
 *      leaving a dirty WAL, then relaunch racing the old process's teardown) is waited out
 *      instead of taking down the daemon.
 */
export function openDb(path: string): Database {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    let db: Database | null = null;
    try {
      db = new Database(path);
      db.exec("PRAGMA busy_timeout = 5000"); // FIRST — so WAL recovery waits, never throws cold
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA wal_autocheckpoint = 1000"); // keep -wal from growing unbounded
      return db;
    } catch (e) {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      lastErr = e;
      const code = String((e as { code?: string })?.code ?? e);
      const transient =
        code.includes("BUSY") || code.includes("LOCKED") || /database is locked/i.test(String(e));
      if (!transient) throw e;
      Bun.sleepSync(100 * (attempt + 1)); // 100ms, 200ms, ... — let the other connection settle
    }
  }
  throw lastErr;
}
