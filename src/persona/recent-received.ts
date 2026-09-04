import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * List the N most-recent files across the sandbox's received-* buckets.
 * Surfaced in the envelope so the model can answer vague references
 * ("edmund explain this") without having to blindly ls and guess.
 */

const BUCKETS = ["received-images", "received-videos", "received-audio", "received-files"] as const;

export type RecentItem = {
  path: string;
  bucket: (typeof BUCKETS)[number];
  mtimeMs: number;
};

/**
 * Per-sandbox cache. Bucket-dir mtime changes whenever an entry is added
 * or removed — exactly when the result of this scan would change — so
 * statSync-ing the 4 bucket dirs is sufficient to decide whether the
 * cached result is still valid. Saves the per-file statSync fan-out on
 * the hot path (worst-case N files per turn → constant 4).
 *
 * iCloud-staged dirs are particularly slow for the full readdir+stat,
 * which is why this lands in the per-turn envelope build.
 */
type CacheEntry = {
  limit: number;
  bucketMtimes: number[]; // one per BUCKETS index; -1 if dir absent
  items: RecentItem[];
};
const cache = new Map<string, CacheEntry>();
/** Cap on distinct sandbox paths held in cache. One entry per
 *  per-session sandbox; in steady state we have ~10s, but rotating
 *  test users or temp sandboxes could grow this unbounded over weeks. */
const CACHE_MAX_ENTRIES = 256;

function bucketSignatures(sandboxPath: string): number[] {
  const sigs: number[] = [];
  for (const bucket of BUCKETS) {
    const dir = join(sandboxPath, bucket);
    try {
      sigs.push(statSync(dir).mtimeMs);
    } catch {
      sigs.push(-1);
    }
  }
  return sigs;
}

function arrEq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function listRecentReceived(sandboxPath: string, limit = 6): RecentItem[] {
  const sigs = bucketSignatures(sandboxPath);
  const hit = cache.get(sandboxPath);
  if (hit && hit.limit === limit && arrEq(hit.bucketMtimes, sigs)) {
    return hit.items;
  }

  const items: RecentItem[] = [];
  for (let i = 0; i < BUCKETS.length; i++) {
    const bucket = BUCKETS[i]!;
    if (sigs[i] === -1) continue;
    const dir = join(sandboxPath, bucket);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        items.push({ path: p, bucket, mtimeMs: st.mtimeMs });
      } catch {
        // Skip unreadable entries; the guard still protects against actions.
      }
    }
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const result = items.slice(0, limit);
  // LRU-by-insertion-order: if at cap, drop the oldest entry before
  // inserting. Updating an existing key keeps its position, so always
  // delete-then-set to refresh recency.
  if (cache.has(sandboxPath)) {
    cache.delete(sandboxPath);
  } else if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(sandboxPath, { limit, bucketMtimes: sigs, items: result });
  return result;
}

/** Test-only: clear the in-process cache so tests don't share state. */
export function _resetRecentReceivedCache(): void {
  cache.clear();
}
