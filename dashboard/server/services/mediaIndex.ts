/**
 * Walk sandbox/<slug>/{images,videos,voice-memos,received-*}/ and surface
 * media items to the dashboard. The harness writes everything chronologically
 * with filenames like `YYYY-MM-DD_HHmmss[_label].ext`.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { extname, join, resolve } from "node:path";
import { sandboxDir } from "../../../src/persona/sandbox.ts";
import type { MediaItem } from "../types.ts";
import type { LabelDeps } from "./labels.ts";
import { sessionLabel } from "./labels.ts";

const SANDBOX_ROOT = resolve(import.meta.dir, "../../../sandbox");

const GENERATED_DIRS = ["images", "videos", "voice-memos"] as const;
const RECEIVED_DIRS = [
  "received-images",
  "received-videos",
  "received-audio",
  "received-files",
] as const;

function classify(path: string): MediaItem["kind"] {
  const ext = extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm", ".m4v"].includes(ext)) return "video";
  if ([".caf", ".m4a", ".mp3", ".wav", ".flac", ".ogg", ".aac"].includes(ext)) return "audio";
  return "other";
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function walk(dir: string, maxDepth: number, out: string[]): void {
  if (maxDepth < 0) return;
  for (const entry of safeList(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let stat: Stats;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, maxDepth - 1, out);
    else if (stat.isFile()) out.push(full);
  }
}

function collectForSession(sessionKey: string, root: string, deps: LabelDeps): MediaItem[] {
  const sessionDir = sandboxDir(sessionKey);
  const label = sessionLabel(sessionKey, deps);
  const items: MediaItem[] = [];
  for (const sub of GENERATED_DIRS) {
    const paths: string[] = [];
    walk(join(sessionDir, sub), 2, paths);
    for (const p of paths) {
      const s = statSync(p);
      items.push({
        sessionKey,
        sessionLabel: label,
        kind: classify(p),
        direction: "generated",
        path: p,
        relativeUrl: relUrl(p, root),
        sizeBytes: s.size,
        mtimeMs: s.mtimeMs,
      });
    }
  }
  for (const sub of RECEIVED_DIRS) {
    const paths: string[] = [];
    walk(join(sessionDir, sub), 2, paths);
    for (const p of paths) {
      const s = statSync(p);
      items.push({
        sessionKey,
        sessionLabel: label,
        kind: classify(p),
        direction: "received",
        path: p,
        relativeUrl: relUrl(p, root),
        sizeBytes: s.size,
        mtimeMs: s.mtimeMs,
      });
    }
  }
  return items;
}

export function listMedia(sessionKeys: string[], deps: LabelDeps): MediaItem[] {
  const out: MediaItem[] = [];
  for (const key of sessionKeys) out.push(...collectForSession(key, SANDBOX_ROOT, deps));
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export function listMediaForSession(sessionKey: string, deps: LabelDeps): MediaItem[] {
  const items = collectForSession(sessionKey, SANDBOX_ROOT, deps);
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

/**
 * Confine `rawPath` to `root` by REAL path, not lexical prefix. A symlink
 * inside the sandbox pointing at ~/.ssh passes a startsWith check and fails
 * this one. Returns the real path or null. Exported for tests.
 */
export function resolveWithin(rawPath: string, root: string): string | null {
  const abs = resolve(rawPath);
  if (!abs.startsWith(`${root}/`) && abs !== root) return null;
  let real: string;
  let rootReal: string;
  try {
    real = realpathSync(abs);
    rootReal = realpathSync(root);
  } catch {
    return null;
  }
  if (!real.startsWith(`${rootReal}/`) && real !== rootReal) return null;
  return real;
}

/** Resolves `sandbox/...` relative path from a dashboard `/api/media/file?path=...` request. */
export function resolveMediaPath(rawPath: string): string | null {
  return resolveWithin(rawPath, SANDBOX_ROOT);
}

function relUrl(abs: string, root: string): string {
  const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
  return `/api/media/file?path=${encodeURIComponent(abs)}&rel=${encodeURIComponent(rel)}`;
}
