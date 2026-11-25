/**
 * Addresses that are refused before a server looks at their request.
 *
 * The security watch decides who is blocked (src/watch/inbound-watch.ts) and
 * writes it to one small file. Every process that serves the outside reads
 * that file, because they are separate processes: the public router, the
 * dashboard, each share's own server. A block is an address or a subnet and
 * an hour at which it ends, so one that nobody lifts lifts itself.
 *
 * It lives this low in the layering because the access log, which wraps
 * every server's handler, is what asks.
 */
import { readFileSync, statSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.ts";

type Block = { until: number; why: string; since: number };
type Blocks = Record<string, Block>;

let file: string | null = null;
let cached: { mtimeMs: number; blocks: Blocks } = { mtimeMs: -1, blocks: {} };

/** Tell this process where the blocklist is. Until it is told, nobody is blocked. */
export function useBlocklist(path: string | null): void {
  file = path;
  cached = { mtimeMs: -1, blocks: {} };
}

function read(): Blocks {
  if (!file) return {};
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return {};
  }
  if (mtimeMs === cached.mtimeMs) return cached.blocks;
  try {
    cached = { mtimeMs, blocks: JSON.parse(readFileSync(file, "utf8")) as Blocks };
  } catch {
    cached = { mtimeMs, blocks: {} };
  }
  return cached.blocks;
}

/** The /24 of an IPv4 address or the /64 of an IPv6 one. */
function subnetKey(ip: string): string {
  if (ip.includes(":")) return `${ip.split(":").slice(0, 4).join(":")}::/64`;
  return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
}

/** Why an address is blocked now, or null when it is not. */
export function blockedReason(ip: string | undefined, now: number = Date.now()): string | null {
  if (!ip || !file) return null;
  const blocks = read();
  for (const key of [ip, subnetKey(ip)]) {
    const block = blocks[key];
    if (block && block.until > now) return block.why;
  }
  return null;
}

/** Everything blocked now. */
export function currentBlocks(now: number = Date.now()): Blocks {
  return Object.fromEntries(Object.entries(read()).filter(([, b]) => b.until > now));
}

/** Block an address or a subnet until a time. Expired entries are dropped as it is written. */
export function block(target: string, why: string, until: number, now: number = Date.now()): void {
  if (!file) return;
  const next = { ...currentBlocks(now), [target]: { until, why, since: now } };
  atomicWriteFileSync(file, `${JSON.stringify(next, null, 1)}\n`);
  cached = { mtimeMs: -1, blocks: {} };
}

/** Lift a block. Returns whether there was one. */
export function unblock(target: string, now: number = Date.now()): boolean {
  if (!file) return false;
  const blocks = currentBlocks(now);
  if (!(target in blocks)) return false;
  delete blocks[target];
  atomicWriteFileSync(file, `${JSON.stringify(blocks, null, 1)}\n`);
  cached = { mtimeMs: -1, blocks: {} };
  return true;
}
