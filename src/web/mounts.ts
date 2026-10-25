import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../util/atomic-write.ts";

/**
 * Path prefixes on the public host that belong to a local server.
 *
 * The kitchen host owns the one named tunnel on this machine. Anything else
 * that needs a permanent public page (an integration's live print page, say)
 * registers a prefix and the loopback port that serves it, and the host
 * proxies matching requests there. A registry file rather than an import, so
 * the host never names the package and deleting the package removes nothing
 * but a stale line, which answers 502 until it is cleared.
 */

export type Mounts = Record<string, number>;

const FILE = "web-mounts.json";

function path(dataDir: string): string {
  return join(dataDir, FILE);
}

export function readMounts(dataDir: string): Mounts {
  const p = path(dataDir);
  if (!existsSync(p)) return {};
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as Mounts;
    return Object.fromEntries(
      Object.entries(m).filter(
        ([k, v]) => /^\/[a-z0-9-]+\/$/.test(k) && Number.isInteger(v) && v > 0,
      ),
    );
  } catch {
    return {};
  }
}

/** Claim a prefix like "/print/" for a server on 127.0.0.1:port. */
export function registerMount(dataDir: string, prefix: string, port: number): void {
  if (!/^\/[a-z0-9-]+\/$/.test(prefix)) throw new Error(`bad mount prefix ${prefix}`);
  mkdirSync(dataDir, { recursive: true });
  atomicWriteFileSync(
    path(dataDir),
    `${JSON.stringify({ ...readMounts(dataDir), [prefix]: port }, null, 2)}\n`,
  );
}

export function unregisterMount(dataDir: string, prefix: string): void {
  const m = readMounts(dataDir);
  if (!(prefix in m)) return;
  delete m[prefix];
  atomicWriteFileSync(path(dataDir), `${JSON.stringify(m, null, 2)}\n`);
}

let cached: { mtime: number; mounts: Mounts } | null = null;

/** The port that serves this path, or null. Re-reads the registry only when it changes. */
export function mountFor(dataDir: string, pathname: string): number | null {
  const p = path(dataDir);
  if (!existsSync(p)) return null;
  const mtime = statSync(p).mtimeMs;
  if (!cached || cached.mtime !== mtime) cached = { mtime, mounts: readMounts(dataDir) };
  for (const [prefix, port] of Object.entries(cached.mounts)) {
    if (pathname.startsWith(prefix)) return port;
  }
  return null;
}
