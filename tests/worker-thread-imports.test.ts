import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// A Worker thread in this daemon may run only the project's own code.
//
// On Bun 1.3.9, what a worker thread adds to the runtime's process-wide
// module cache dies once workers are created and terminated. A package first
// loaded by a worker is exactly that: the embedder was one, and the next
// worker's import of it failed until the daemon restarted, or segfaulted the
// daemon (2026-10-28 to 2026-11-16). The embedder is a process now. This
// keeps the next worker from walking into the same thing: anything that needs
// a package or a native addon belongs in a child process.

const SRC = resolve(import.meta.dir, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Every module a file names, in any of the ways a file can name one. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

const isBuiltin = (spec: string) => spec.startsWith("node:") || spec.startsWith("bun:");
const isRelative = (spec: string) => spec.startsWith("./") || spec.startsWith("../");

/** The packages a worker entry would load, following its own files. */
function packagesLoadedBy(entry: string, seen = new Set<string>()): string[] {
  if (seen.has(entry)) return [];
  seen.add(entry);
  const packages: string[] = [];
  for (const spec of specifiers(readFileSync(entry, "utf8"))) {
    if (isBuiltin(spec)) continue;
    if (!isRelative(spec)) {
      packages.push(`${spec} (from ${entry.slice(SRC.length + 1)})`);
      continue;
    }
    const target = resolve(dirname(entry), spec);
    if (existsSync(target)) packages.push(...packagesLoadedBy(target, seen));
  }
  return packages;
}

/** Where the global Worker is constructed, and the file each one runs. */
function workerThreads(): Array<{ file: string; entry: string | null }> {
  const sites: Array<{ file: string; entry: string | null }> = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    // A file that imports its own `Worker` means a class of ours, not a thread.
    if (/\bimport\b[^;]*\bWorker\b[^;]*\bfrom\b/.test(source)) continue;
    for (const site of source.matchAll(/\bnew Worker\(\s*([A-Za-z_$][\w$]*|new URL\([^)]*\))/g)) {
      const arg = site[1]!;
      const url = arg.startsWith("new URL(")
        ? arg
        : (new RegExp(`\\b${arg}\\s*=\\s*(new URL\\([^)]*\\))`).exec(source)?.[1] ?? "");
      const rel = /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/.exec(url)?.[1];
      sites.push({
        file: file.slice(SRC.length + 1),
        entry: rel ? resolve(dirname(file), rel) : null,
      });
    }
  }
  return sites;
}

describe("worker threads run only the project's own code", () => {
  const threads = workerThreads();

  test("the daemon's worker threads are found", () => {
    // If this list changes, the guard below is looking at the right things
    // only if the new site is in it.
    expect(threads.map((t) => t.file).sort()).toEqual([
      "refresh/runner.ts",
      "triggers/evaluate.ts",
    ]);
  });

  test("each one names a file this test can read", () => {
    for (const thread of threads) {
      expect(
        thread.entry,
        `${thread.file} starts a worker this guard cannot follow`,
      ).not.toBeNull();
      expect(existsSync(thread.entry!), `${thread.entry} does not exist`).toBe(true);
    }
  });

  test("none of them loads a package", () => {
    for (const thread of threads) {
      if (!thread.entry) continue;
      expect(packagesLoadedBy(thread.entry), `worker started in ${thread.file}`).toEqual([]);
    }
  });

  test("the embedder is a process, not a worker thread", () => {
    const provider = readFileSync(join(SRC, "memory/embed-provider.ts"), "utf8");
    expect(provider).not.toMatch(/\bnew Worker\(/);
    expect(provider).toMatch(/Bun\.spawn\(/);
    expect(existsSync(join(SRC, "memory/transformers-embed-worker.ts"))).toBe(false);
  });

  test("the guard sees a package when there is one", () => {
    // The embedding process loads a package, which is why it is a process.
    const loaded = packagesLoadedBy(join(SRC, "memory/transformers-embed-child.ts"));
    expect(loaded.join("\n")).toContain("@huggingface/transformers");
  });
});
