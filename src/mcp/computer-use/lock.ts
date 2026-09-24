/**
 * One screen, one driver.
 *
 * Every conversation gets its own MCP server process, and two of them
 * clicking at once would each act on a screen the other just changed. The
 * first to act takes a lock file and keeps it until its turn is over: the
 * daemon calls `endScreenHold` when a turn ends, which signals that
 * session's server to quit what it opened and let go. Anyone else who wants
 * the screen meanwhile waits (session.ts).
 *
 * A holder whose process has died loses the lock at once. One that is alive
 * but has not acted for HOLD_IDLE_MS is presumed stuck and loses it too, and
 * a holder that notices it has been idle that long lets go on its own.
 *
 * Every read-then-change of the lock file (taking it, refreshing it, taking
 * it from a dead or idle holder, letting it go, clearing it for the daemon)
 * happens under a kernel lock on a sibling file (`guarded`), so no two
 * processes act on the same reading. Without it, two servers that both read a
 * dead holder's lock could both end up holding the screen: one removed the
 * dead lock and wrote its own, and the other then removed that.
 */

import { spawnSync } from "node:child_process";
import {
  constants,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * How long a holder may go without acting before the screen is taken from
 * it. Long enough for a slow turn's pauses between screen actions; a turn
 * that ends normally releases the screen straight away.
 */
export const HOLD_IDLE_MS = 10 * 60_000;

/** What the daemon sends a holder whose turn has ended. */
export const END_HOLD_SIGNAL = "SIGUSR2";

export type Holder = { pid: number; session: string; since: number; touched: number };

export function screenLockPath(dataDir: string): string {
  return join(dataDir, "computer-use", "screen.lock");
}

export class ScreenLock {
  private held = false;

  private readonly path: string;
  private readonly session: string;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;

  constructor(opts: {
    path: string;
    session: string;
    pid?: number;
    now?: () => number;
    alive?: (pid: number) => boolean;
  }) {
    this.path = opts.path;
    this.session = opts.session;
    this.pid = opts.pid ?? process.pid;
    this.now = opts.now ?? Date.now;
    this.alive = opts.alive ?? pidAlive;
  }

  /**
   * Take or refresh the lock. Returns why not when another conversation
   * holds it, without naming that conversation.
   */
  acquire(): string | null {
    mkdirSync(dirname(this.path), { recursive: true });
    const outcome = guarded(this.path, () => {
      const current = readHolder(this.path);
      if (current && current.pid === this.pid) {
        writeHolder(this.path, { ...current, touched: this.now() });
        return null;
      }
      if (current && this.alive(current.pid) && this.now() - current.touched < HOLD_IDLE_MS) {
        const secs = Math.round((this.now() - current.since) / 1000);
        return `Another conversation has been using the screen for ${secs}s.`;
      }
      // Free, or its holder is dead or idle: nobody else can be between this
      // reading and this write.
      const t = this.now();
      writeHolder(this.path, { pid: this.pid, session: this.session, since: t, touched: t });
      return null;
    });
    if (!outcome) return "Another conversation just started using the screen.";
    if (outcome.value === null) this.held = true;
    return outcome.value;
  }

  /** Whether another conversation holds the screen right now. */
  heldByOther(): boolean {
    const holder = readHolder(this.path);
    return !!holder && holder.pid !== this.pid && this.alive(holder.pid);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    guarded(this.path, () => {
      if (readHolder(this.path)?.pid === this.pid) removeFile(this.path);
    });
  }
}

/** Darwin's open(2) flag that takes an exclusive flock on the file as it opens. */
const O_EXLOCK = 0x20;
/** How long to wait for another process to leave its guarded section, which takes microseconds. */
const GUARD_WAIT_MS = 250;
const GUARD_RETRY_MS = 2;

/**
 * Run `fn` holding the guard for the lock file at `path`: an exclusive flock
 * on `path.guard`, taken as the file opens and dropped when it closes or its
 * process dies, so a crash can never leave it held. The guard file is never
 * deleted: a process waiting on a deleted file's lock would hold a lock
 * nobody else checks. Null when another process kept the guard for longer
 * than GUARD_WAIT_MS. macOS only, like the rest of this server.
 */
function guarded<T>(path: string, fn: () => T): { value: T } | null {
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK;
  for (let waited = 0; waited <= GUARD_WAIT_MS; waited += GUARD_RETRY_MS) {
    let fd: number;
    try {
      fd = openSync(`${path}.guard`, flags, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      Bun.sleepSync(GUARD_RETRY_MS);
      continue;
    }
    try {
      return { value: fn() };
    } finally {
      closeSync(fd);
    }
  }
  return null;
}

/** Replace the lock file whole, so a reader outside the guard never sees half of it. */
function writeHolder(path: string, h: Holder): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(h));
  renameSync(tmp, path);
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

/**
 * The daemon's half: a turn for `session` has ended, so if that session holds
 * the screen, tell its server to clean up and let go. A holder that has
 * already exited just has its lock cleared. Another session's hold is never
 * touched, and a pid is only signalled after checking it is still a
 * computer-use server (pids are reused, and SIGUSR2 ends most processes).
 */
export function endScreenHold(
  path: string,
  session: string,
  deps: {
    alive?: (pid: number) => boolean;
    isServer?: (pid: number) => boolean;
    signal?: (pid: number) => void;
  } = {},
): "signalled" | "cleared" | "none" {
  const holder = readHolder(path);
  if (!holder || holder.session !== session) return "none";
  const alive = deps.alive ?? pidAlive;
  const isServer = deps.isServer ?? isScreenServer;
  if (alive(holder.pid) && isServer(holder.pid)) {
    (deps.signal ?? ((pid) => process.kill(pid, END_HOLD_SIGNAL)))(holder.pid);
    return "signalled";
  }
  // Only if it is still that holder's: another server may have taken the
  // screen from it since it was read.
  const cleared = guarded(path, () => {
    const now = readHolder(path);
    if (now?.pid !== holder.pid || now.since !== holder.since) return false;
    removeFile(path);
    return true;
  });
  return cleared?.value ? "cleared" : "none";
}

function readHolder(path: string): Holder | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Holder;
  } catch {
    return null;
  }
}

function isScreenServer(pid: number): boolean {
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.includes("computer-use/server.ts");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
