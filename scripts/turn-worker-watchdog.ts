#!/usr/bin/env bun
/**
 * Stops a daemon's turn workers when the daemon is gone.
 *
 * Started by the daemon, in its own process group so that whatever ends the
 * daemon does not end this too. It asks the system whether the daemon's pid is
 * still there, which answers the same however the daemon went: an exit, a
 * crash or a kill. Not `process.ppid`: bun keeps the value it first read, so
 * it goes on naming a parent that has died. See src/recovery/turn-workers.ts.
 */
import { stopWorkersOf } from "../src/recovery/turn-workers.ts";

const [dir, ownerArg] = process.argv.slice(2);
const owner = Number(ownerArg);
if (!dir || !Number.isInteger(owner) || owner <= 1) {
  console.error("usage: turn-worker-watchdog <ledger dir> <daemon pid>");
  process.exit(2);
}

function ownerRunning(): boolean {
  try {
    process.kill(owner, 0);
    return true;
  } catch (err) {
    // Only "no such process" means gone.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const watch = setInterval(() => {
  if (ownerRunning()) return;
  clearInterval(watch);
  void stopWorkersOf(dir, owner).finally(() => process.exit(0));
}, 200);
