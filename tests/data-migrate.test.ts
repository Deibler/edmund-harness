/**
 * Moving a data folder from the old flat layout to the grouped one: every
 * file to its place, nothing overwritten, and never a database some process
 * still has open.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditDataDir } from "../src/util/data-layout.ts";
import {
  applyMigration,
  finishMigration,
  planMigration,
  prepareDataFolder,
  unmigratedDatabases,
} from "../src/util/data-migrate.ts";

let root = "";
let data = "";
let logs = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "data-migrate-"));
  data = join(root, "data");
  logs = join(root, "logs");
  mkdirSync(data);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, body = rel): void {
  const path = join(data, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

/** A data folder as a deployment had it on 2026-11-25. */
function oldLayout(): void {
  for (const f of [
    "state.db",
    "state.db-wal",
    "state.db-shm",
    "cron.db",
    "recall.sqlite",
    "recall.sqlite-wal",
  ])
    put(f);
  for (const f of [
    "mcp.json",
    "mcp-guest.json",
    "pool-stats.json",
    "people-maintainer.kick",
    "portal-tunnel-url",
  ])
    put(f);
  for (const f of [
    "dashboard.secret",
    "sms-tunnel-token",
    "signing/keychain-password",
    "voice-lab/key",
  ])
    put(f);
  for (const f of [
    "installed-skills.json",
    "addressing.jsonl",
    "web-mounts.json",
    "pending/abc.jsonl",
  ])
    put(f);
  for (const f of [
    "addressing/labels.json",
    "reviews/2026-10-25.md",
    "turn-workers/123",
    "facetime/turn-clips/a.wav",
  ])
    put(f);
  for (const f of [
    "daemon.log",
    "dashboard.log",
    "launchd.err.log",
    "kitchen-host.log",
    "sms-tunnel.launchd.log",
  ])
    put(f);
  for (const f of [
    "logs/cron/2026-11-25.jsonl",
    "logs/daemon/2026-11-24.log.gz",
    "logs/archive/daemon-old.log.gz",
  ])
    put(f);
  // What stays where it is.
  for (const f of [
    "kitchen/tenants.json",
    "printer/printer.db",
    "shelf/abc/index.html",
    "evals/recall-needles.jsonl",
  ])
    put(f);
}

const all = (dir: string, prefix = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? all(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );

describe("migrating a data folder", () => {
  test("every file goes to its place, with its contents", () => {
    oldLayout();
    const plan = planMigration(data, logs);
    expect(plan.conflicts).toEqual([]);
    const result = applyMigration(plan, () => null);
    finishMigration(data, logs);
    expect(result.left).toEqual([]);

    expect(all(data).sort()).toEqual(
      [
        "db/cron.db",
        "db/recall.sqlite",
        "db/recall.sqlite-wal",
        "db/state.db",
        "db/state.db-shm",
        "db/state.db-wal",
        "evals/addressing/labels.json",
        "evals/recall-needles.jsonl",
        "evals/reviews/2026-10-25.md",
        "kitchen/tenants.json",
        "printer/printer.db",
        "run/facetime/turn-clips/a.wav",
        "run/mcp-guest.json",
        "run/mcp.json",
        "run/people-maintainer.kick",
        "run/pool-stats.json",
        "run/portal-tunnel-url",
        "run/turn-workers/123",
        "secrets/dashboard.secret",
        "secrets/signing/keychain-password",
        "secrets/sms-tunnel-token",
        "secrets/voice-lab/key",
        "shelf/abc/index.html",
        "state/addressing.jsonl",
        "state/installed-skills.json",
        "state/pending/abc.jsonl",
        "state/web-mounts.json",
      ].sort(),
    );
    expect(all(logs).sort()).toEqual(
      [
        "archive/daemon-old.log.gz",
        "cron/2026-11-25.jsonl",
        "daemon.log",
        "daemon/2026-11-24.log.gz",
        "dashboard.log",
        "services/kitchen-host.log",
        "services/launchd.err.log",
        "services/sms-tunnel.launchd.log",
      ].sort(),
    );
    expect(readFileSync(join(data, "db", "state.db-wal"), "utf8")).toBe("state.db-wal");
    // Nothing at the top of the data folder is a loose file any more, and the audit agrees.
    expect(readdirSync(data).sort()).toEqual([
      "db",
      "evals",
      "kitchen",
      "printer",
      "run",
      "secrets",
      "shelf",
      "state",
    ]);
    expect(auditDataDir(data).filter((f) => f.status !== "known")).toEqual([]);
  });

  test("a second run finds nothing to do", () => {
    oldLayout();
    applyMigration(planMigration(data, logs), () => null);
    finishMigration(data, logs);
    const again = planMigration(data, logs);
    expect(again).toEqual({ moves: [], conflicts: [] });
  });

  test("a database some process has open stops everything before anything moves", () => {
    oldLayout();
    const before = all(data).sort();
    const result = applyMigration(planMigration(data, logs), (path) =>
      path.endsWith("cron.db") ? "bun" : null,
    );
    expect(result.refused).toContain("cron.db is open in bun");
    expect(result.moved).toEqual([]);
    expect(all(data).sort()).toEqual(before);
    expect(existsSync(logs)).toBe(false);
  });

  test("a log another program still writes is left where it is, and the rest moves", () => {
    oldLayout();
    const result = applyMigration(planMigration(data, logs), (path) =>
      path.endsWith("kitchen-host.log") ? "cloudflared" : null,
    );
    expect(result.left).toEqual([
      {
        path: join(data, "kitchen-host.log"),
        reason: "still written by cloudflared; it moves once that restarts",
      },
    ]);
    expect(existsSync(join(data, "kitchen-host.log"))).toBe(true);
    expect(existsSync(join(data, "db", "state.db"))).toBe(true);
  });

  test("a destination that exists is a conflict, and is not replaced", () => {
    oldLayout();
    put("db/state.db", "the one already there");
    const plan = planMigration(data, logs);
    expect(plan.conflicts).toEqual([
      { from: join(data, "state.db"), to: join(data, "db", "state.db") },
    ]);
    applyMigration(plan, () => null);
    expect(readFileSync(join(data, "db", "state.db"), "utf8")).toBe("the one already there");
    expect(readFileSync(join(data, "state.db"), "utf8")).toBe("state.db");
  });

  test("logs merge into a logs folder a newer process has already started", () => {
    oldLayout();
    mkdirSync(join(logs, "cron"), { recursive: true });
    writeFileSync(join(logs, "cron", "2026-11-26.jsonl"), "newer");
    applyMigration(planMigration(data, logs), () => null);
    expect(readdirSync(join(logs, "cron")).sort()).toEqual([
      "2026-11-25.jsonl",
      "2026-11-26.jsonl",
    ]);
  });
});

describe("starting on a folder that was not migrated", () => {
  test("is refused, naming the command; a migrated or a new folder is not", () => {
    expect(() => prepareDataFolder(data)).not.toThrow();
    oldLayout();
    expect(unmigratedDatabases(data).sort()).toEqual(["cron.db", "recall.sqlite", "state.db"]);
    expect(() => prepareDataFolder(data)).toThrow("edmund data migrate --apply");
    applyMigration(planMigration(data, logs), () => null);
    expect(() => prepareDataFolder(data)).not.toThrow();
  });

  test("the audit says what is in the old layout and where it belongs", () => {
    put("state.db");
    put("launchd.err.log");
    put("logs/cron/2026-11-25.jsonl");
    const byName = new Map(auditDataDir(data).map((f) => [f.name, f]));
    expect(byName.get("state.db")).toMatchObject({
      status: "misplaced",
      why: "belongs at db/state.db",
    });
    expect(byName.get("launchd.err.log")!.status).toBe("misplaced");
    expect(byName.get("logs")!.status).toBe("misplaced");
  });
});
