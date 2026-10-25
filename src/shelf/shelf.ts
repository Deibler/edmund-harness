import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { atomicWriteFileSync } from "../util/atomic-write.ts";

/**
 * A person's shelf: everything Edmund hands them to keep, at a link that does
 * not die. Over the 30 days to 2026-10-25 he sent 42 quick-tunnel links, which
 * lapse within days, against 9 links to a page that lasts; one person stopped
 * using Edmund after a dead link at the moment of handoff, and others asked
 * again and again for files they had already been sent. The shelf lives under
 * the permanent kitchen host (the only named tunnel this machine runs), keyed
 * by an unguessable per-chat token.
 */

export type ShelfEntry = { name: string; title: string; addedMs: number; bytes: number };

export function shelfRoot(dataDir: string): string {
  return join(dataDir, "shelf");
}

/** The chat's shelf token, created on first use. */
export function shelfToken(dataDir: string, sessionKey: string): string {
  const root = shelfRoot(dataDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, "tokens.json");
  let tokens: Record<string, string> = {};
  if (existsSync(path)) {
    try {
      tokens = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch {
      tokens = {};
    }
  }
  const existing = tokens[sessionKey];
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const token = randomBytes(16).toString("hex");
  tokens[sessionKey] = token;
  atomicWriteFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`);
  return token;
}

/** A file name that is safe in a URL path and on disk. */
export function shelfName(raw: string): string {
  const ext = extname(raw)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, "");
  const stem = basename(raw, extname(raw))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return `${stem || "file"}${ext}`;
}

export function readShelfIndex(dir: string): ShelfEntry[] {
  const path = join(dir, "index.json");
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ShelfEntry[];
  } catch {
    return [];
  }
}

/**
 * Copy a file onto the chat's shelf and return its permanent link and the
 * shelf's own page. A different file under a name already taken gets a
 * numbered name; the same file again keeps its link.
 */
export function shelveFile(args: {
  dataDir: string;
  sessionKey: string;
  src: string;
  origin: string;
  title?: string;
  name?: string;
}): { url: string; shelfUrl: string; path: string } {
  if (!existsSync(args.src)) throw new Error(`file not found: ${args.src}`);
  const token = shelfToken(args.dataDir, args.sessionKey);
  const dir = join(shelfRoot(args.dataDir), token);
  mkdirSync(dir, { recursive: true });
  const bytes = statSync(args.src).size;
  const wanted = shelfName(args.name ?? basename(args.src));
  let name = wanted;
  for (let i = 2; existsSync(join(dir, name)) && statSync(join(dir, name)).size !== bytes; i++) {
    name = `${basename(wanted, extname(wanted))}-${i}${extname(wanted)}`;
  }
  const dest = join(dir, name);
  copyFileSync(args.src, dest);
  const all = readShelfIndex(dir);
  const previous = all.find((e) => e.name === name);
  const index = all.filter((e) => e.name !== name);
  index.push({
    name,
    title: args.title?.trim() || previous?.title || name,
    addedMs: Date.now(),
    bytes,
  });
  atomicWriteFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  const base = `${args.origin.replace(/\/+$/, "")}/shelf/${token}/`;
  return { url: `${base}${encodeURIComponent(name)}`, shelfUrl: base, path: dest };
}
