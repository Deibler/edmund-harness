/**
 * The direction dependencies run between the modules under src/, enforced.
 *
 * A module is a top-level directory of src/. Each sits in one layer, and a
 * file may import (at runtime) only from its own module or from a module in
 * a lower layer. That makes the module graph acyclic, which is what lets a
 * module be read, tested and changed without holding the rest in mind.
 *
 * Measured on 2026-11-25, before this test existed: 20 of the 48 modules
 * formed one knot in which each depended, through the others, on all of
 * them, while the files themselves held only two import cycles. The files
 * were sound and the folders were not: a persona loader lived in the Claude
 * runner's folder, the code that runs a fired job lived with the job store
 * that everything writes to, a registry of live calls lived in the call
 * feature that the pipeline sits beneath. Twenty-six files moved and one
 * import was left against the grain, listed below.
 *
 * `import type` is not counted: it is erased before anything runs, and a
 * type may be named from anywhere. A file that needs something from a
 * higher layer is telling you one of three things: the thing it needs
 * belongs lower, the file belongs higher, or the higher layer should hand
 * it in (the way main.ts hands every subsystem its stores). Move it; do not
 * add it to EXCEPTIONS without writing down why none of the three holds.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { Glob } from "bun";

const REPO = join(import.meta.dir, "..");

/** Bottom first. A module may import from any layer above its own in this list. */
const LAYERS: { name: string; modules: string[] }[] = [
  { name: "foundation", modules: ["config", "db", "jev", "portal", "tools", "util"] },
  {
    name: "state and local services",
    modules: ["concierge", "media", "refresh", "sessions", "shelf", "spend", "voice", "web"],
  },
  {
    name: "transports and registries",
    modules: [
      "announce",
      "grok",
      "guests",
      "imessage",
      "integrations",
      "security",
      "sms",
      "triggers",
    ],
  },
  { name: "the model runtime", modules: ["alerts", "gating", "model"] },
  { name: "what a turn reads and schedules", modules: ["cron", "persona", "research", "skills"] },
  { name: "what a turn recalls", modules: ["memory"] },
  { name: "the turn pipeline", modules: ["agents", "channels", "relay"] },
  {
    name: "features on the pipeline",
    modules: ["calls", "credits", "evals", "ghost", "recovery", "watch"],
  },
  { name: "features that use other features", modules: ["background", "ideation"] },
  { name: "entry surfaces", modules: ["boot", "mcp", "scheduler"] },
];

/**
 * Directories that are one module. `model/` holds the contract every backend
 * meets and the dispatcher that picks one; `claude/` and `codex/` are the
 * backends. Each needs the other two, so the three are layered as one.
 */
const SAME_MODULE: Record<string, string> = { claude: "model", codex: "model" };

/**
 * Imports that run against the layering, each with the reason it stays.
 * Every entry is a debt: the list should only get shorter.
 */
const EXCEPTIONS: { from: string; to: string; why: string }[] = [
  {
    from: "src/agents/spawn.ts",
    to: "src/ideation/settle.ts",
    why:
      "An agent that built an unasked page must be settled, not announced, on every path that " +
      "settles an agent: the runner's exit, the reaper and a failed spawn, in three processes. " +
      "A static import holds on all three; a hook registered at boot would hold only where " +
      "someone remembered to register it.",
  },
];

/** File-level import cycles that exist today. New ones fail; these should be untangled. */
const KNOWN_FILE_CYCLES: string[][] = [
  ["src/claude/healers.ts", "src/claude/runner.ts"],
  ["integrations/mirror/refresh.ts", "integrations/mirror/tools.ts"],
];

type Edge = { from: string; to: string; typeOnly: boolean; dynamic: boolean };

const IMPORT_RE =
  /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ["src", "integrations", "cli", "scripts", "dashboard/server"]) {
    for (const f of new Glob("**/*.ts").scanSync({ cwd: join(REPO, root) })) {
      if (f.includes("node_modules/") || f.endsWith(".d.ts")) continue;
      if (f.endsWith(".test.ts") || f.includes("/test/") || f.startsWith("test/")) continue;
      out.push(`${root}/${f}`);
    }
  }
  return out.sort();
}

function importEdges(files: string[]): Edge[] {
  const known = new Set(files);
  const edges: Edge[] = [];
  for (const f of files) {
    const code = readFileSync(join(REPO, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const m of code.matchAll(IMPORT_RE)) {
      const spec = m[3] ?? m[4] ?? m[5];
      if (!spec?.startsWith(".")) continue;
      const base = normalize(join(dirname(f), spec));
      const to = [base, `${base}.ts`, join(base, "index.ts")].find((c) => known.has(c));
      if (!to) continue;
      edges.push({
        from: f,
        to,
        typeOnly: Boolean(m[2]) && Boolean(m[3]),
        dynamic: Boolean(m[4] ?? m[5]),
      });
    }
  }
  return edges;
}

/** The module a file under src/ belongs to, or null for src/main.ts and files outside src/. */
function moduleOf(file: string): string | null {
  const parts = file.split("/");
  if (parts[0] !== "src" || parts.length < 3) return null;
  return SAME_MODULE[parts[1]!] ?? parts[1]!;
}

const FILES = sourceFiles();
const EDGES = importEdges(FILES);
const RANK = new Map<string, number>();
LAYERS.forEach((layer, i) => {
  for (const m of layer.modules) RANK.set(m, i);
});

describe("module layering", () => {
  test("the scan sees the codebase", () => {
    // A scan that finds nothing passes everything.
    expect(FILES.length).toBeGreaterThan(500);
    expect(EDGES.length).toBeGreaterThan(2000);
  });

  test("every module under src/ is in exactly one layer", () => {
    const onDisk = new Set(FILES.map(moduleOf).filter((m): m is string => m !== null));
    const listed = LAYERS.flatMap((l) => l.modules);
    expect(listed.filter((m, i) => listed.indexOf(m) !== i)).toEqual([]);
    // A new directory has to be placed before it can be imported from.
    expect([...onDisk].filter((m) => !RANK.has(m)).sort()).toEqual([]);
    expect(listed.filter((m) => !onDisk.has(m)).sort()).toEqual([]);
  });

  test("a module imports only from lower layers", () => {
    const allowed = new Set(EXCEPTIONS.map((e) => `${e.from} -> ${e.to}`));
    const upward: string[] = [];
    for (const e of EDGES) {
      if (e.typeOnly) continue;
      const a = moduleOf(e.from);
      const b = moduleOf(e.to);
      if (!a || !b || a === b) continue;
      if (RANK.get(b)! < RANK.get(a)!) continue;
      const key = `${e.from} -> ${e.to}`;
      if (allowed.has(key)) continue;
      upward.push(`${key}   (${a}, layer ${RANK.get(a)} -> ${b}, layer ${RANK.get(b)})`);
    }
    expect([...new Set(upward)].sort()).toEqual([]);
  });

  test("every exception is still in use", () => {
    // An exception whose import is gone is a hole left open for the next one.
    const live = new Set(EDGES.filter((e) => !e.typeOnly).map((e) => `${e.from} -> ${e.to}`));
    expect(
      EXCEPTIONS.filter((e) => !live.has(`${e.from} -> ${e.to}`)).map(
        (e) => `${e.from} -> ${e.to}`,
      ),
    ).toEqual([]);
  });

  test("nothing under src/ imports from the entry points or from outside src/", () => {
    const outward: string[] = [];
    for (const e of EDGES) {
      if (!e.from.startsWith("src/")) continue;
      if (e.to === "src/main.ts") outward.push(`${e.from} -> ${e.to}`);
      else if (!e.to.startsWith("src/")) outward.push(`${e.from} -> ${e.to}`);
    }
    expect([...new Set(outward)].sort()).toEqual([]);
  });
});

describe("import cycles between files", () => {
  test("there are no new ones", () => {
    const adj = new Map<string, string[]>();
    for (const e of EDGES) {
      if (e.typeOnly || e.dynamic) continue;
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from)!.push(e.to);
    }
    // Tarjan's strongly connected components.
    let next = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const cycles: string[][] = [];
    const visit = (v: string): void => {
      index.set(v, next);
      low.set(v, next++);
      stack.push(v);
      onStack.add(v);
      for (const w of adj.get(v) ?? []) {
        if (!index.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
      if (low.get(v) !== index.get(v)) return;
      const group: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
        if (w === v) break;
      }
      if (group.length > 1) cycles.push(group.sort());
    };
    for (const f of FILES) if (!index.has(f)) visit(f);
    const known = new Set(KNOWN_FILE_CYCLES.map((c) => [...c].sort().join(" <-> ")));
    const found = cycles.map((c) => c.join(" <-> ")).sort();
    expect(found.filter((c) => !known.has(c))).toEqual([]);
    // A known cycle that has been untangled comes off the list.
    expect([...known].filter((c) => !found.includes(c))).toEqual([]);
  });
});

describe("paths other things point at", () => {
  // launchd agents, generated MCP configs, skills and the CLI start these by
  // path. The compiler cannot see a path in a plist; moving one of these
  // stops a service the next time it starts.
  const ENTRY_POINTS = [
    "src/main.ts",
    "src/mcp/server.ts",
    "src/mcp/computer-use/server.ts",
    "src/ghost/mcp-server.ts",
    "cli/main.ts",
    "dashboard/server/main.ts",
    "scripts/agent-runner.ts",
    "scripts/bg-runner.ts",
    "scripts/turn-worker-watchdog.ts",
    "scripts/post-compact-thread.ts",
    "scripts/launchd/service.sh",
    "scripts/launchd/run-daemon.sh",
    "scripts/launchd/run-dashboard.sh",
  ];
  test("the entry points are where they are started from", () => {
    const missing = ENTRY_POINTS.filter((p) => !Bun.file(join(REPO, p)).size);
    expect(missing).toEqual([]);
  });

  test("the scripts the daemon starts by path exist", () => {
    // Each of these modules builds the path of a script from its own
    // location. Read the path it actually computes, not a copy of it.
    const repoRelative = (p: string) => relative(REPO, p);
    return Promise.all([
      import("../src/model/direct-env.ts").then((m) => m.POST_COMPACT_HOOK_SCRIPT),
      import("../src/model/turn-workers.ts").then((m) => m.WATCHDOG_SCRIPT),
    ]).then((paths) => {
      expect(paths.map(repoRelative)).toEqual([
        "scripts/post-compact-thread.ts",
        "scripts/turn-worker-watchdog.ts",
      ]);
      for (const p of paths) expect(Bun.file(p).size).toBeGreaterThan(0);
    });
  });
});
