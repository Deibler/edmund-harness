/**
 * The data folder's contents are declared (src/util/data-layout.ts): a real
 * folder is held against the list, and a clean moves aside only what the list
 * names as retired or what is plainly an old backup.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATA_LAYOUT,
  RETIRED_DATA,
  applyClean,
  auditDataDir,
  entryFor,
  planClean,
} from "../src/util/data-layout.ts";

const ROOT = join(import.meta.dir, "..");
const DAY = 86_400_000;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "data-layout-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(name: string, ageDays = 0, bytes = 10): string {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
  const at = new Date(Date.now() - ageDays * DAY);
  utimesSync(path, at, at);
  return path;
}

describe("every path the code builds under the data folder is declared", () => {
  /** First path segment after the data folder, wherever the code joins or interpolates one. */
  function namesInCode(): Map<string, string> {
    const found = new Map<string, string>();
    const patterns = [
      // join(dataDir, "x"), join(resolve(config.paths.data_dir), "x"), join(dataDir(), "x")
      // The data folder itself must be the first argument: join(printerDir(dataDir), "x") is a path
      // inside a folder that is already declared.
      /(?:join|resolve)\(\s*(?:resolve\(\s*)?[\w.]*?(?:data_dir|dataDir|DATA_DIR)(?:\(\))?\s*\)?\s*,\s*"([^"]+)"/g,
      /\$\{[^}]*(?:data_dir|dataDir)[^}]*\}\/([A-Za-z0-9_.\-]+)/g,
    ];
    for (const top of ["src", "scripts", "cli", "dashboard/server", "integrations"]) {
      for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: join(ROOT, top) })) {
        const file = `${top}/${rel}`;
        if (file.includes(".test.") || file.includes("/test/") || file.includes("node_modules")) {
          continue;
        }
        const text = readFileSync(join(ROOT, file), "utf8");
        for (const pattern of patterns) {
          for (const m of text.matchAll(pattern)) {
            const name = m[1]!.split("/")[0]!;
            if (name) found.set(name, file);
          }
        }
      }
    }
    return found;
  }

  // Arguments that follow a data folder in a call and are not paths in it.
  const NOT_A_PATH = new Set(["[dash] ", "public-router", ""]);

  test("no undeclared name", () => {
    const undeclared: string[] = [];
    for (const [name, file] of namesInCode()) {
      if (NOT_A_PATH.has(name)) continue;
      // A name the code only completes later (`grok-connector-url.`) matches by its prefix.
      const declared =
        entryFor(name) ?? DATA_LAYOUT.find((e) => e.name.includes("*") && e.name.startsWith(name));
      if (!declared) undeclared.push(`${name} (${file})`);
    }
    expect(undeclared).toEqual([]);
  });

  test("the scan finds the paths it is meant to", () => {
    const names = namesInCode();
    for (const expected of ["state.db", "daemon.log", "cron.db", "logs", "turn-workers"]) {
      expect(names.has(expected)).toBe(true);
    }
    expect(names.size).toBeGreaterThan(50);
  });

  test("nothing is both declared and retired", () => {
    for (const retired of RETIRED_DATA) {
      expect(DATA_LAYOUT.find((e) => e.name === retired.name)).toBeUndefined();
    }
  });
});

describe("auditing a folder", () => {
  test("sorts entries into known, retired, backup and unknown", () => {
    put("state.db");
    put("state.db-wal");
    put("portal-tunnel-url");
    put("portal-tunnel.log");
    put("mcp-guest.json");
    put("trading.db");
    put("trading.db-shm");
    put("mcp-trading.json");
    put("one-off-notes.log", 120);
    put("fresh-notes.log", 5);
    put("typo.db", 45, 0);
    put("typo-today.db", 1, 0);
    put("spend.db.bak-2026-09-24T22-41-28-609Z");
    put("mystery/chrome-profile/Cookies", 0, 500);
    put("logs/cron/2026-11-25.jsonl");
    const byName = new Map(auditDataDir(dir).map((f) => [f.name, f]));
    expect(byName.get("state.db")!.entry!.kind).toBe("database");
    expect(byName.get("state.db-wal")!.status).toBe("known");
    expect(byName.get("portal-tunnel-url")!.entry!.kind).toBe("state");
    expect(byName.get("portal-tunnel.log")!.entry!.kind).toBe("log");
    expect(byName.get("mcp-guest.json")!.status).toBe("known");
    expect(byName.get("trading.db")!.status).toBe("retired");
    expect(byName.get("trading.db-shm")!.status).toBe("retired");
    // Declared configs match `mcp-*.json`; the removed feature's is named as retired and that wins.
    expect(byName.get("mcp-trading.json")!.status).toBe("retired");
    // What no list could name: undeclared, and empty or a log, and long untouched.
    expect(byName.get("one-off-notes.log")!.status).toBe("stale");
    expect(byName.get("fresh-notes.log")!.status).toBe("unknown");
    expect(byName.get("typo.db")!.status).toBe("stale");
    expect(byName.get("typo-today.db")!.status).toBe("unknown");
    expect(byName.get("spend.db.bak-2026-09-24T22-41-28-609Z")!.status).toBe("backup");
    expect(byName.get("mystery")).toMatchObject({ status: "unknown", bytes: 500, isFolder: true });
    expect(byName.get("logs")!.status).toBe("known");
  });
});

describe("cleaning a folder", () => {
  test("moves retired entries and old backups aside; leaves known, unknown and recent backups", () => {
    put("state.db");
    put("trading.db", 100);
    put("typo.db", 200, 0);
    put("SOUL.md.bak-20260924", 60);
    put("printer.db.bak-yesterday", 1);
    put("mystery/file", 300);
    const steps = planClean(dir);
    expect(steps.map((s) => (s.action === "trash" ? s.finding.name : s.path)).sort()).toEqual([
      "SOUL.md.bak-20260924",
      "trading.db",
      "typo.db",
    ]);
    const result = applyClean(dir, steps, () => null, "2026-11-25");
    expect(result.trashed.map((t) => t.name).sort()).toEqual([
      "SOUL.md.bak-20260924",
      "trading.db",
      "typo.db",
    ]);
    expect(readdirSync(dir).sort()).toEqual([
      ".trash",
      "mystery",
      "printer.db.bak-yesterday",
      "state.db",
    ]);
    expect(readdirSync(join(dir, ".trash", "2026-11-25")).sort()).toEqual([
      "SOUL.md.bak-20260924",
      "trading.db",
      "typo.db",
    ]);
  });

  test("a file some process still has open stays where it is", () => {
    put("annotations.db", 100);
    put("trading.db", 100);
    const result = applyClean(dir, planClean(dir), (path) =>
      path.endsWith("annotations.db") ? "bun" : null,
    );
    expect(result.skipped).toEqual([{ name: "annotations.db", reason: "still open in bun" }]);
    expect(existsSync(join(dir, "annotations.db"))).toBe(true);
    expect(existsSync(join(dir, "trading.db"))).toBe(false);
  });

  test("a declared cache loses its old files and keeps its recent ones", () => {
    put("media/transcode/old.stt.wav", 45);
    put("media/transcode/new.stt.wav", 2);
    put("shelf/abc/old-but-permanent.html", 400);
    const steps = planClean(dir);
    expect(steps).toHaveLength(1);
    applyClean(dir, steps, () => null);
    expect(readdirSync(join(dir, "media", "transcode"))).toEqual(["new.stt.wav"]);
    expect(existsSync(join(dir, "shelf", "abc", "old-but-permanent.html"))).toBe(true);
  });

  test("what was moved aside is deleted after thirty days, not before", () => {
    put(".trash/2026-01-01/trading.db");
    put(`.trash/${new Date().toISOString().slice(0, 10)}/typo.db`);
    const steps = planClean(dir);
    expect(steps).toHaveLength(1);
    applyClean(dir, steps, () => null);
    expect(readdirSync(join(dir, ".trash"))).toEqual([new Date().toISOString().slice(0, 10)]);
  });
});
