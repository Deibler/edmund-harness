/**
 * Where the watch listens, and the settings that make a worker report to it.
 *
 * Claude Code can call an HTTP endpoint before and after every tool call
 * (measured on CLI 2.1.332, 2026-11-25): the request carries the tool's name
 * and arguments, and an answer of "deny" stops the call before it runs. No
 * process is started per call, which is what makes watching every call
 * affordable. When nothing answers, the call goes ahead and the CLI says so
 * in its event stream (`hook_no_verdict`), so a watch that has gone quiet is
 * itself visible.
 *
 * The daemon writes down where it listens at every start; whatever starts a
 * worker reads it here. A worker started while no watch is running gets no
 * hook and behaves as it always did.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../util/atomic-write.ts";

export type WatchAddress = { port: number; key: string };

const addressFile = (dataDir: string) => join(dataDir, "run", "watch.json");

/** The watch says where it is and mints the key a hook must present. */
export function announceWatch(dataDir: string, port: number): WatchAddress {
  const address = { port, key: randomBytes(24).toString("hex") };
  atomicWriteFileSync(addressFile(dataDir), `${JSON.stringify(address)}\n`);
  try {
    chmodSync(addressFile(dataDir), 0o600);
  } catch {}
  return address;
}

/** Take the address down, so that nothing started after this waits on a watch that is gone. */
export function withdrawWatch(dataDir: string): void {
  rmSync(addressFile(dataDir), { force: true });
}

/** Where the watch is now; null when none is running or none has run. */
export function readWatchAddress(dataDir: string): WatchAddress | null {
  try {
    const raw = JSON.parse(readFileSync(addressFile(dataDir), "utf8")) as Partial<WatchAddress>;
    if (typeof raw.port !== "number" || typeof raw.key !== "string" || !raw.key) return null;
    return { port: raw.port, key: raw.key };
  } catch {
    return null;
  }
}

/**
 * How long a call may wait on the watch, in seconds. Longer than the watch
 * ever takes to answer a held call (the judge's own limit is shorter), so
 * that the watch decides what happens to a slow verdict and the CLI's own
 * timeout only catches a watch that has stopped answering.
 */
const HOOK_TIMEOUT_SECONDS = { before: 20, after: 5 } as const;

/**
 * The settings fragment that sends every tool call of one session's worker
 * to the watch: before it runs, where it can be refused, and after, with
 * what came back. Empty when there is no watch to report to.
 */
export function watchHookSettings(
  address: WatchAddress | null,
  sessionKey: string,
): Record<string, unknown> {
  if (!address) return {};
  const base = `http://127.0.0.1:${address.port}`;
  const session = encodeURIComponent(sessionKey);
  const hook = (path: string, timeout: number) => ({
    matcher: "*",
    hooks: [
      {
        type: "http",
        url: `${base}/${path}/${session}`,
        timeout,
        headers: { Authorization: `Bearer ${address.key}` },
      },
    ],
  });
  return {
    hooks: {
      PreToolUse: [hook("pre", HOOK_TIMEOUT_SECONDS.before)],
      PostToolUse: [hook("post", HOOK_TIMEOUT_SECONDS.after)],
    },
  };
}

/** Two settings fragments as one: their hooks side by side, everything else from the later. */
export function mergeSettings(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const hooksA = (a.hooks ?? {}) as Record<string, unknown[]>;
  const hooksB = (b.hooks ?? {}) as Record<string, unknown[]>;
  const hooks: Record<string, unknown[]> = {};
  for (const event of new Set([...Object.keys(hooksA), ...Object.keys(hooksB)])) {
    hooks[event] = [...(hooksA[event] ?? []), ...(hooksB[event] ?? [])];
  }
  return { ...a, ...b, ...(Object.keys(hooks).length > 0 ? { hooks } : {}) };
}
