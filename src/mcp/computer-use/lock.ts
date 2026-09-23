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
 */

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = readHolder(this.path);
      if (current && current.pid === this.pid) {
        this.write({ ...current, touched: this.now() });
        this.held = true;
        return null;
      }
      if (current && this.alive(current.pid) && this.now() - current.touched < HOLD_IDLE_MS) {
        const secs = Math.round((this.now() - current.since) / 1000);
        return `Another conversation has been using the screen for ${secs}s.`;
      }
      if (current) this.remove();
      try {
        const fd = openSync(this.path, "wx");
        closeSync(fd);
        const t = this.now();
        this.write({ pid: this.pid, session: this.session, since: t, touched: t });
        this.held = true;
        return null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Another process created it between our read and our create.
      }
    }
    return "Another conversation just started using the screen.";
  }

  /** Whether another conversation holds the screen right now. */
  heldByOther(): boolean {
    const holder = readHolder(this.path);
    return !!holder && holder.pid !== this.pid && this.alive(holder.pid);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    if (readHolder(this.path)?.pid === this.pid) this.remove();
  }

  private write(h: Holder): void {
    writeFileSync(this.path, JSON.stringify(h));
  }

  private remove(): void {
    try {
      unlinkSync(this.path);
    } catch {}
  }
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
  try {
    unlinkSync(path);
  } catch {}
  return "cleared";
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
