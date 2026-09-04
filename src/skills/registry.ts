/**
 * Skill marketplace registry — fetches `marketplace.json` from allowlisted
 * GitHub repos and lets callers pull a skill's full file tree.
 *
 * Source format: `owner/repo` (e.g. "anthropics/skills"). The repo must
 * have a `marketplace.json` at its default-branch root with the shape:
 *
 *   {
 *     "name": "anthropics-skills",
 *     "skills": [
 *       { "name": "pdf-extract", "path": "pdf-extract",
 *         "description": "Extract text from PDFs", "version": "1.0.0" }
 *     ]
 *   }
 *
 * `path` is the directory within the repo that holds `SKILL.md`. Names
 * across sources collide — the installer namespaces local installs under
 * the skill name only (with an owner suffix on conflict).
 */

import { z } from "zod";

const SkillEntrySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i),
  path: z.string().min(1).max(256),
  description: z.string().min(1).max(500),
  version: z.string().min(1).max(64).optional(),
  /** Optional: skill author flags scripts/executables that operator must approve. */
  scripts: z.boolean().optional(),
});

const ManifestSchema = z.object({
  name: z.string().min(1),
  skills: z.array(SkillEntrySchema).max(2000),
});

export type SkillEntry = z.infer<typeof SkillEntrySchema> & { source: string };
export type Manifest = z.infer<typeof ManifestSchema>;

export type FetchOptions = {
  allowedSources: string[];
  timeoutMs: number;
};

const SOURCE_RE = /^[a-z0-9][a-z0-9-_.]*\/[a-z0-9][a-z0-9-_.]*$/i;

export function isAllowedSource(source: string, allowlist: string[]): boolean {
  if (!SOURCE_RE.test(source)) return false;
  return allowlist.includes(source);
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "edmund-harness" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`http ${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "edmund-harness" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`http ${r.status} ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

export async function loadManifest(source: string, opts: FetchOptions): Promise<Manifest> {
  if (!isAllowedSource(source, opts.allowedSources)) {
    throw new Error(`source not allowlisted: ${source}`);
  }
  const url = `https://raw.githubusercontent.com/${source}/HEAD/marketplace.json`;
  const raw = await fetchJson(url, opts.timeoutMs);
  return ManifestSchema.parse(raw);
}

export async function searchMarketplace(
  query: string | undefined,
  opts: FetchOptions,
): Promise<SkillEntry[]> {
  const q = (query ?? "").toLowerCase().trim();
  const out: SkillEntry[] = [];
  for (const source of opts.allowedSources) {
    try {
      const manifest = await loadManifest(source, opts);
      for (const entry of manifest.skills) {
        const hay = `${entry.name} ${entry.description}`.toLowerCase();
        if (!q || hay.includes(q)) out.push({ ...entry, source });
      }
    } catch {
      // Skip unreachable sources; the search is best-effort.
    }
  }
  return out;
}

export type SkillFile = { path: string; content: string };

/**
 * Walk a skill's directory via the GitHub contents API and return every
 * file as `{path, content}` (path relative to the skill root). Refuses
 * symlinks, submodules, and files larger than 1 MB.
 */
export async function fetchSkillFiles(
  source: string,
  skillPath: string,
  opts: FetchOptions,
): Promise<SkillFile[]> {
  if (!isAllowedSource(source, opts.allowedSources)) {
    throw new Error(`source not allowlisted: ${source}`);
  }
  if (skillPath.includes("..") || skillPath.startsWith("/")) {
    throw new Error(`invalid skill path: ${skillPath}`);
  }

  const out: SkillFile[] = [];
  const stack: string[] = [skillPath];
  let fileCount = 0;

  while (stack.length > 0) {
    const cur = stack.pop()!;
    const url = `https://api.github.com/repos/${source}/contents/${cur}`;
    const entries = (await fetchJson(url, opts.timeoutMs)) as GhEntry | GhEntry[];
    const list = Array.isArray(entries) ? entries : [entries];

    for (const e of list) {
      if (e.type === "dir") {
        stack.push(e.path);
        continue;
      }
      if (e.type !== "file") {
        // Reject symlinks ("symlink") and submodules ("submodule").
        throw new Error(`unsupported entry type ${e.type} at ${e.path}`);
      }
      if (typeof e.size !== "number" || e.size > 1_000_000) {
        throw new Error(`file too large (>1MB): ${e.path}`);
      }
      if (++fileCount > 200) {
        throw new Error(`skill exceeds 200 files`);
      }
      if (!e.download_url) {
        throw new Error(`no download_url for ${e.path}`);
      }
      const content = await fetchText(e.download_url, opts.timeoutMs);
      const rel = e.path.startsWith(`${skillPath}/`)
        ? e.path.slice(skillPath.length + 1)
        : e.path === skillPath
          ? ""
          : e.path;
      out.push({ path: rel || e.path.split("/").pop()!, content });
    }
  }
  return out;
}

type GhEntry = {
  type: string;
  path: string;
  size?: number;
  download_url?: string | null;
};
