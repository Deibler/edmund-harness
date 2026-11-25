import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
import { type TurnWorkerEntry, reapTurnWorkers } from "../src/model/turn-workers.ts";

const root = join(import.meta.dir, "..");

// These tests start and kill real processes. Alone they take about two
// seconds; beside three hundred other test files they need the room.
setDefaultTimeout(30_000);
const dirs: string[] = [];
const groups: number[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  for (const dir of dirs.splice(0)) {
    // A watchdog that failed to stop itself would otherwise outlive the run.
    for (const pid of watchdogsFor(dir)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "edmund-turn-workers-"));
  dirs.push(dir);
  return dir;
}

/** A worker as the daemon spawns one: its own process group, with children in it. */
function spawnWorker(): number {
  const worker = spawn("/bin/sh", ["-c", "sleep 300 & sleep 300 & wait"], {
    detached: true,
    stdio: "ignore",
  });
  groups.push(worker.pid!);
  return worker.pid!;
}

/** The watchdogs running for a stand-in daemon's data directory. */
function watchdogsFor(dataDir: string): number[] {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return ps.stdout
    .split("\n")
    .filter((line) => line.includes(`turn-worker-watchdog.ts ${dataDir}`))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A pid that belonged to a process which has already exited. */
function deadPid(): number {
  return spawnSync("/usr/bin/true").pid;
}

function writeDown(dir: string, entry: Partial<TurnWorkerEntry> & { pid: number }): void {
  const whole: TurnWorkerEntry = {
    spawnedMs: Date.now(),
    owner: deadPid(),
    ownerStartedMs: Date.now(),
    label: "dm:+15550100",
    ...entry,
  };
  writeFileSync(join(dir, `${whole.pid}.json`), JSON.stringify(whole));
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the process state");
    await Bun.sleep(25);
  }
}

/**
 * A stand-in daemon: guards its workers as the real one does at boot, spawns
 * one, says which, and then stays up until something ends it.
 */
async function startDaemon(
  dataDir: string,
): Promise<{ daemon: ChildProcess; worker: number; logged: () => string }> {
  const script = join(dataDir, "daemon.ts");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { guardTurnWorkers, trackTurnWorker } from ${JSON.stringify(join(root, "src/model/turn-workers.ts"))};
await guardTurnWorkers(process.argv[2]);
const worker = spawn("/bin/sh", ["-c", "sleep 300 & sleep 300 & wait"], { detached: true, stdio: "ignore" });
trackTurnWorker(worker, "dm:+15550100");
console.log("worker=" + worker.pid);
setInterval(() => {}, 1_000);
`,
  );
  const daemon = spawn(process.execPath, [script, dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(daemon);
  let out = "";
  const collect = (chunk: Buffer) => {
    out += chunk.toString("utf8");
  };
  daemon.stdout!.on("data", collect);
  daemon.stderr!.on("data", collect);
  await until(() => /worker=\d+/.test(out));
  const worker = Number(out.match(/worker=(\d+)/)![1]);
  groups.push(worker);
  return { daemon, worker, logged: () => out };
}

describe("turn workers answer to one daemon", () => {
  // The incident: the daemon died, its workers finished their turns and sent
  // them, and the next daemon replayed the same messages to new workers.
  test("a worker is stopped, with its whole tree, when its daemon is killed", async () => {
    const dataDir = tempDir();
    const { daemon, worker } = await startDaemon(dataDir);
    expect(groupAlive(worker)).toBe(true);
    expect(watchdogsFor(dataDir)).toHaveLength(1);
    // A daemon dies after its watchdog has been watching for a while, never
    // in its first instant. A watchdog that reads the parent pid bun cached
    // on first use passes without this wait and never fires with it.
    await Bun.sleep(700);

    daemon.kill("SIGKILL");
    await until(() => !groupAlive(worker));
    // Nothing is left written down but the watchdog's note of what it stopped.
    const ledger = join(dataDir, "run", "turn-workers");
    await until(() => readdirSync(ledger).join() === "last-stop");
    expect(JSON.parse(readFileSync(join(ledger, "last-stop"), "utf8"))).toMatchObject({
      owner: daemon.pid,
      sessions: ["dm:+15550100"],
    });
    // And the watchdog, its work done, does not stay behind.
    await until(() => watchdogsFor(dataDir).length === 0);
  });

  // The backstop: if the watchdog was not there to do it, boot does.
  test("a daemon stops the last daemon's workers as it boots", async () => {
    const dataDir = tempDir();
    const ledger = join(dataDir, "run", "turn-workers");
    mkdirSync(ledger, { recursive: true });
    const leftover = spawnWorker();
    writeDown(ledger, { pid: leftover });

    const { worker } = await startDaemon(dataDir);
    await until(() => !groupAlive(leftover));
    // Its own worker is another matter.
    expect(groupAlive(worker)).toBe(true);
    expect(readdirSync(ledger)).toEqual([`${worker}.json`]);
  });

  test("the next daemon reports what the watchdog stopped, once", async () => {
    const dataDir = tempDir();
    const ledger = join(dataDir, "run", "turn-workers");
    mkdirSync(ledger, { recursive: true });
    writeFileSync(
      join(ledger, "last-stop"),
      JSON.stringify({ atMs: Date.now(), owner: 4242, sessions: ["dm:+15550100"] }),
    );

    const { logged } = await startDaemon(dataDir);
    expect(logged()).toContain("went down with workers still running");
    expect(logged()).toContain("dm:+15550100");
    expect(existsSync(join(ledger, "last-stop"))).toBe(false);
  });

  // The guard runs at the top of boot. If it could fail, so could boot, and a
  // daemon that cannot boot is the crash loop this exists to make harmless.
  test("a daemon boots even when it cannot keep the ledger", async () => {
    const dataDir = tempDir();
    const script = join(dataDir, "boot.ts");
    // A data directory that is a file: the ledger cannot be created under it.
    const blocked = join(dataDir, "not-a-directory");
    writeFileSync(blocked, "");
    writeFileSync(
      script,
      `import { spawn } from "node:child_process";
import { guardTurnWorkers, trackTurnWorker } from ${JSON.stringify(join(root, "src/model/turn-workers.ts"))};
await guardTurnWorkers(process.argv[2]);
const worker = spawn("/usr/bin/true", [], { detached: true, stdio: "ignore" });
trackTurnWorker(worker, "dm:+15550100");
await new Promise((done) => worker.once("exit", done));
console.log("booted");
`,
    );
    const boot = spawnSync(process.execPath, [script, blocked], { encoding: "utf8" });
    expect(boot.stdout).toContain("booted");
    expect(boot.status).toBe(0);
    await until(() => watchdogsFor(blocked).length === 0);
  });

  test("a worker is written down while it runs and forgotten when it exits", async () => {
    const dataDir = tempDir();
    const { daemon, worker } = await startDaemon(dataDir);
    const entryPath = join(dataDir, "run", "turn-workers", `${worker}.json`);
    const entry = JSON.parse(readFileSync(entryPath, "utf8")) as TurnWorkerEntry;
    expect(entry).toMatchObject({ pid: worker, owner: daemon.pid, label: "dm:+15550100" });

    process.kill(-worker, "SIGKILL");
    await until(() => !existsSync(entryPath));
  });

  test("the next daemon stops what the last one left running", async () => {
    const dir = tempDir();
    const worker = spawnWorker();
    writeDown(dir, { pid: worker });

    const stopped = await reapTurnWorkers(dir);
    expect(stopped.map((entry) => entry.pid)).toEqual([worker]);
    await until(() => !groupAlive(worker));
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a worker that ignores the request to stop is killed", async () => {
    const dir = tempDir();
    const stubborn = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 300 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    groups.push(stubborn.pid!);
    // Let the shell install its trap before anything is sent to it.
    await Bun.sleep(200);
    writeDown(dir, { pid: stubborn.pid! });

    await reapTurnWorkers(dir, { graceMs: 300 });
    await until(() => !groupAlive(stubborn.pid!));
  });

  test("a worker whose daemon is still running is left alone", async () => {
    const dir = tempDir();
    const owner = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
    children.push(owner);
    const worker = spawnWorker();
    writeDown(dir, { pid: worker, owner: owner.pid!, ownerStartedMs: Date.now() });

    expect(await reapTurnWorkers(dir)).toEqual([]);
    expect(groupAlive(worker)).toBe(true);
    expect(readdirSync(dir)).toEqual([`${worker}.json`]);

    // Unless the caller knows that daemon is gone, as its watchdog does.
    const stopped = await reapTurnWorkers(dir, { owner: owner.pid! });
    expect(stopped.map((entry) => entry.pid)).toEqual([worker]);
    await until(() => !groupAlive(worker));
  });

  test("a daemon's pid in use by something else does not keep its workers alive", async () => {
    const dir = tempDir();
    const impostor = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
    children.push(impostor);
    const worker = spawnWorker();
    // The pid the daemon had, now a process that began an hour after it did.
    writeDown(dir, {
      pid: worker,
      owner: impostor.pid!,
      ownerStartedMs: Date.now() - 3_600_000,
    });

    const stopped = await reapTurnWorkers(dir);
    expect(stopped.map((entry) => entry.pid)).toEqual([worker]);
    await until(() => !groupAlive(worker));
    expect(impostor.exitCode).toBeNull();
    expect(impostor.signalCode).toBeNull();
  });

  test("a pid that is no longer the worker is left alone", async () => {
    const dir = tempDir();
    // The same pid, but a process that began an hour after the worker did.
    const reused = spawnWorker();
    writeDown(dir, { pid: reused, spawnedMs: Date.now() - 3_600_000 });
    // The right age, but not at the head of a process group of its own.
    const member = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
    children.push(member);
    writeDown(dir, { pid: member.pid! });

    expect(await reapTurnWorkers(dir)).toEqual([]);
    expect(groupAlive(reused)).toBe(true);
    expect(member.exitCode).toBeNull();
    expect(member.signalCode).toBeNull();
    // Neither entry names a worker any more, so neither is kept.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("an entry that cannot be read is dropped, not acted on", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "123.json"), "{not json");
    writeFileSync(join(dir, "456.json"), JSON.stringify({ pid: 789 }));

    expect(await reapTurnWorkers(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("turn workers, structurally", () => {
  const sourcesIn = (folder: string) =>
    readdirSync(join(root, folder))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `${folder}/${name}`);

  // One-shots answer a question for the daemon and deliver nothing themselves.
  // The ledger starts its own watchdog detached, which is not a model process.
  const deliversNothing = new Set([
    "src/claude/one-shot.ts",
    "src/model/one-shot.ts",
    "src/model/turn-workers.ts",
  ]);

  test("every detached model process that runs a turn is written down", () => {
    // The whole model runtime: the backends and what they share.
    const detached = [
      ...sourcesIn("src/model"),
      ...sourcesIn("src/claude"),
      ...sourcesIn("src/codex"),
    ].filter(
      (file) =>
        !deliversNothing.has(file) &&
        readFileSync(join(root, file), "utf8").includes("detached: true"),
    );
    expect(detached.sort()).toEqual([
      "src/claude/runner.ts",
      "src/claude/worker.ts",
      "src/codex/runner.ts",
    ]);
    for (const file of detached) {
      const source = readFileSync(join(root, file), "utf8");
      const spawns = source.split("detached: true").length - 1;
      const tracked = source.split("trackTurnWorker(").length - 1;
      expect([file, tracked]).toEqual([file, spawns]);
    }
  });

  test("the daemon guards its workers before it serves a send or replays a message", () => {
    const main = readFileSync(join(root, "src/main.ts"), "utf8");
    const guard = main.indexOf("await guardTurnWorkers(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(main.indexOf("await serveBridgeControl("));
    expect(guard).toBeLessThan(main.indexOf("await runCatchUp("));
    expect(main.indexOf("await serveBridgeControl(")).toBeGreaterThan(-1);
    expect(main.indexOf("await runCatchUp(")).toBeGreaterThan(-1);
  });
});
