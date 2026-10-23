/**
 * How a sub-agent ends, and how its parent hears about it.
 *
 * Measured on the live store 2026-10-23: the reaper killed agents 15
 * minutes after spawn whatever they were doing (33 of 35 had written output
 * within the last 151s), the runner died on SIGTERM without writing a
 * result, cancel signalled the runner but not its CLI, a sub-agent's
 * background job woke a session that does not exist (262 times), and a
 * fan-out woke the parent once per agent (up to 19 in a row).
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsRoutes } from "../dashboard/server/routes/agents.ts";
import { writeFollowOnMarker } from "../src/agents/follow-on.ts";
import { withAgentHeartbeat } from "../src/agents/keep-alive.ts";
import {
  COMPLETION_DEBOUNCE_MS,
  COMPLETION_MAX_WAIT_MS,
  agentCompletionMessage,
  isCompletionEvent,
  mergeCompletionEvents,
  queueCompletionWakeUp,
} from "../src/agents/messages.ts";
import { AGENT_LIMITS, reapStuckAgents } from "../src/agents/reaper.ts";
import {
  type LaunchEnvFor,
  agentModelProblem,
  cancelAgent,
  killAgentProcess,
  notifyParent,
  spawnAgent,
} from "../src/agents/spawn.ts";
import { AgentStore } from "../src/agents/store.ts";
import { dispatchOrRun } from "../src/background/dispatch.ts";
import { BG_EXECUTORS } from "../src/background/registry.ts";
import { spawnBgJob } from "../src/background/spawn.ts";
import { CronStore } from "../src/cron/store.ts";
import type { ToolContext } from "../src/mcp/context.ts";

const root = join(import.meta.dir, "..");
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
// Runner process groups a test started: stopped even when an assertion
// failed before the test stopped them itself.
const groups: number[] = [];
afterAll(() => {
  for (const pid of groups) {
    if (!(pid > 0)) continue; // kill(-0) would signal this test's own group
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PARENT = "imessage:dm:+15550100021";
const MIN = 60_000;

// A fake `claude` the real runner starts (tests/fixtures/fake-claude-agent.ts).
const fakeBin = tmp("fake-agent-bin-");
writeFileSync(
  join(fakeBin, "claude"),
  `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures/fake-claude-agent.ts")}" "$@"\n`,
);
chmodSync(join(fakeBin, "claude"), 0o755);
// No test here may start the real CLI, even through a path that falls back
// to this process's own env (a follow-on launched without a launch env).
const realPath = process.env.PATH;
process.env.PATH = `${fakeBin}:${realPath}`;
afterAll(() => {
  process.env.PATH = realPath;
});
const fakeEnv =
  (extra: Record<string, string>): LaunchEnvFor =>
  () => ({
    ...(process.env as Record<string, string>),
    PATH: `${fakeBin}:${process.env.PATH}`,
    EDMUND_AGENT_MODEL: "claude-test-9",
    ...extra,
  });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A detached process group (`sh` leading a `sleep`): returns both pids. */
async function processGroup(): Promise<{ leader: number; child: number }> {
  const leader = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  groups.push(leader.pid!);
  const child = Number(
    await new Promise<string>((r) => leader.stdout!.once("data", (b) => r(String(b)))),
  );
  return { leader: leader.pid!, child };
}
const waitFor = async (cond: () => boolean, tries = 300) => {
  for (let i = 0; i < tries && !cond(); i++) await Bun.sleep(20);
  return cond();
};

function fixture() {
  const dataDir = tmp("agents-data-");
  const store = new AgentStore(dataDir);
  const crons = new CronStore(dataDir);
  const add = (opts: { teamId?: string; role?: string } = {}) => {
    const sb = join(dataDir, "sb", "agents", `a${Math.random().toString(36).slice(2)}`);
    mkdirSync(sb, { recursive: true });
    return store.create(
      { parentSessionKey: PARENT, task: "find three sources", ...opts },
      { sandboxPath: sb, resultPath: join(sb, "result.md"), logPath: join(sb, "agent.log") },
    );
  };
  // Backdate a row; the store stamps spawned_at itself.
  const age = (id: string, spawnedAgoMs: number, heartbeatAgoMs: number | null) => {
    const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
    const now = Date.now();
    db.query("UPDATE agents SET spawned_at=?, heartbeat_at=? WHERE id=?").run(
      now - spawnedAgoMs,
      heartbeatAgoMs === null ? null : now - heartbeatAgoMs,
      id,
    );
  };
  const completions = () =>
    crons.listActive(PARENT).filter((j) => isCompletionEvent(j.systemEvent));
  return { dataDir, store, crons, add, age, completions };
}

describe("the reaper judges an agent by its output, not its age", () => {
  test("a working agent past 15 minutes is left alone; a silent one is stopped", () => {
    const f = fixture();
    const working = f.add();
    const silent = f.add();
    const legacy = f.add();
    const capped = f.add();
    for (const a of [working, silent, legacy, capped]) f.store.claimRunning(a.id, 0);
    f.age(working.id, 40 * MIN, 30_000);
    f.age(silent.id, 40 * MIN, 16 * MIN);
    f.age(legacy.id, 16 * MIN, null); // from before heartbeats
    f.age(capped.id, 91 * MIN, 5_000);
    const stuck = f.store.listStuck(AGENT_LIMITS).map((a) => a.id);
    expect(stuck.sort()).toEqual([silent.id, legacy.id, capped.id].sort());
  });

  test("a reaped agent is settled once, says why, and its parent hears once", () => {
    const f = fixture();
    const a = f.add();
    f.store.claimRunning(a.id, 0); // pid 0 is falsy: the reaper signals nothing
    f.age(a.id, 30 * MIN, 20 * MIN);
    expect(reapStuckAgents(f.store, f.crons, f.dataDir)).toEqual([a.id]);
    expect(reapStuckAgents(f.store, f.crons, f.dataDir)).toEqual([]);
    const row = f.store.get(a.id)!;
    expect(row.status).toBe("failed");
    expect(row.stopReason).toBe("stopped after 20 minutes without any output");
    const wake = f.completions();
    expect(wake).toHaveLength(1);
    expect(wake[0]!.systemEvent).toContain("stopped after 20 minutes without any output");
    expect(wake[0]!.systemEvent).toContain(`read_agent_result("${a.id}")`);
  });

  test("whoever settles first wins; the runner cannot revive a settled row", () => {
    const f = fixture();
    const a = f.add();
    expect(f.store.finishIfActive(a.id, "canceled", null, "canceled by its parent")).toEqual({
      pid: null,
      from: "pending",
    });
    expect(f.store.claimRunning(a.id, 1)).toBe(false);
    expect(f.store.finishIfActive(a.id, "done", 0)).toBeNull();
    expect(f.store.get(a.id)!.status).toBe("canceled");
  });

  test("a settle reports the pid it took, and can require the status that was judged", () => {
    const f = fixture();
    const a = f.add();
    f.store.claimRunning(a.id, 4242);
    expect(f.store.finishIfActive(a.id, "failed", null, "never started", "pending")).toBeNull();
    expect(f.store.get(a.id)!.status).toBe("running");
    expect(f.store.finishIfActive(a.id, "failed", null, "x", "running")).toEqual({
      pid: 4242,
      from: "running",
    });
  });

  test("the reaper stops the process the settle found, not the one it read", async () => {
    const f = fixture();
    const a = f.add();
    const g = await processGroup();
    f.store.claimRunning(a.id, g.leader);
    f.age(a.id, 30 * MIN, 20 * MIN);
    // The sweep's read was taken before the runner stored its pid.
    const stale = { ...f.store.get(a.id)!, pid: null };
    f.store.listStuck = () => [stale];
    expect(reapStuckAgents(f.store, f.crons, f.dataDir)).toEqual([a.id]);
    expect(await waitFor(() => !alive(g.child))).toBe(true);
  });

  test("a pending row its runner claims during the sweep is left for the next one", () => {
    const f = fixture();
    const a = f.add();
    f.age(a.id, 2 * MIN, null);
    const judgedPending = f.store.get(a.id)!;
    f.store.claimRunning(a.id, 0);
    f.store.listStuck = () => [judgedPending];
    expect(reapStuckAgents(f.store, f.crons, f.dataDir)).toEqual([]);
    expect(f.store.get(a.id)!.status).toBe("running");
    expect(f.completions()).toHaveLength(0);
  });
});

describe("a team reports once", () => {
  test("two members that both see the team settled send one team-done", () => {
    const f = fixture();
    const team = "team_test_1";
    const m1 = f.add({ teamId: team, role: "a" });
    const m2 = f.add({ teamId: team, role: "b" });
    f.store.finishIfActive(m1.id, "done", 0);
    f.store.finishIfActive(m2.id, "failed", 1);
    for (const m of [m1, m2]) {
      notifyParent({
        store: f.store,
        crons: f.crons,
        dataDir: f.dataDir,
        agent: f.store.get(m.id)!,
      });
    }
    const wake = f.completions();
    expect(wake).toHaveLength(1);
    expect(wake[0]!.systemEvent).toStartWith("An agent team has finished (1 done, 1 failed)");
  });

  test("the team decision holds the write lock against other processes", () => {
    const f = fixture();
    const team = "team_test_lock";
    const m = f.add({ teamId: team });
    f.store.finishIfActive(m.id, "done", 0);
    // Another runner's connection, unwilling to wait.
    const other = new Database(join(f.dataDir, "agents.db"));
    other.exec("PRAGMA busy_timeout = 0");
    let otherWrote: boolean | null = null;
    notifyParent({
      store: f.store,
      crons: f.crons,
      dataDir: f.dataDir,
      agent: f.store.get(m.id)!,
      duringTeamDecision: () => {
        try {
          other.query("INSERT OR IGNORE INTO team_done(team_id, fired_at) VALUES ('x', 1)").run();
          otherWrote = true;
        } catch {
          otherWrote = false;
        }
      },
    });
    other.close();
    expect(otherWrote).toBe(false);
    expect(f.completions()).toHaveLength(1);
  });

  test("a synthesizer one member spawned holds the team open, then reports itself", async () => {
    const f = fixture();
    const team = "team_test_follow";
    const m1 = f.add({ teamId: team, role: "scout" });
    const m2 = f.add({ teamId: team, role: "scout" });
    const shared = join(f.dataDir, "sb", "teams", team, "shared");
    mkdirSync(shared, { recursive: true });
    writeFollowOnMarker(shared, {
      role: "synthesizer",
      task: "merge what the scouts found",
      parentSessionKey: PARENT,
      parentSandbox: join(f.dataDir, "sb"),
    });
    // Both settle before either reports: each will see the team settled.
    f.store.finishIfActive(m1.id, "done", 0);
    f.store.finishIfActive(m2.id, "done", 0);
    const launchEnv = fakeEnv({ FAKE_AGENT_MODE: "finish" });
    for (const m of [m1, m2]) {
      notifyParent({
        store: f.store,
        crons: f.crons,
        dataDir: f.dataDir,
        agent: f.store.get(m.id)!,
        launchEnv,
      });
    }
    const synth = f.store.listTeam(team).find((a) => a.role === "synthesizer")!;
    expect(synth).toBeDefined();
    // The second member saw the synthesizer in flight: nothing went out yet.
    expect(f.completions()).toHaveLength(0);
    // The synthesizer's own runner settles the team and reports it.
    expect(await waitFor(() => f.completions().length > 0, 500)).toBe(true);
    const wake = f.completions();
    expect(wake).toHaveLength(1);
    expect(wake[0]!.systemEvent).toContain(`synthesizer (${synth.id}): done`);
  }, 20_000);

  test("a follow-on the reaper spawns runs with the configured agent settings", async () => {
    const f = fixture();
    const team = "team_test_daemon";
    const m = f.add({ teamId: team, role: "scout" });
    const shared = join(f.dataDir, "sb", "teams", team, "shared");
    mkdirSync(shared, { recursive: true });
    writeFollowOnMarker(shared, {
      role: "synthesizer",
      task: "merge what the scouts found",
      parentSessionKey: PARENT,
      parentSandbox: join(f.dataDir, "sb"),
    });
    f.store.claimRunning(m.id, 0);
    f.age(m.id, 30 * MIN, 20 * MIN);
    const plugin = tmp("plugin-");
    const seen: string[] = [];
    reapStuckAgents(f.store, f.crons, f.dataDir, {
      launchEnv: (parent, sandbox) => {
        seen.push(`${parent} ${sandbox}`);
        return fakeEnv({
          FAKE_AGENT_MODE: "argv",
          EDMUND_AGENT_MODEL: "claude-configured-7",
          EDMUND_HOST_ACCESS: "full",
          EDMUND_PLUGIN_DIRS: JSON.stringify([plugin]),
        })(parent, sandbox);
      },
    });
    expect(seen).toEqual([`${PARENT} ${join(f.dataDir, "sb")}`]);
    const synth = f.store.listTeam(team).find((a) => a.role === "synthesizer")!;
    expect(await waitFor(() => existsSync(synth.resultPath), 500)).toBe(true);
    expect(await waitFor(() => readFileSync(synth.resultPath, "utf8").startsWith("["))).toBe(true);
    const argv = JSON.parse(readFileSync(synth.resultPath, "utf8")) as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-configured-7");
    expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe(plugin);
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("Task");
  }, 20_000);

  test("the daemon's reaper hands follow-ons the env an MCP child would get", () => {
    const src = readFileSync(join(root, "src/boot/wire-recovery.ts"), "utf8");
    expect(src).toMatch(
      /reapStuckAgents\(agentStore, crons, config\.paths\.data_dir, \{\s*launchEnv: \(parentKey, parentSandbox\) => toolEnv\(config, parentKey, parentSandbox\),/,
    );
  });

  test("a running teammate is not failed by a sibling's settle", () => {
    const f = fixture();
    const team = "team_test_2";
    const quick = f.add({ teamId: team });
    const slow = f.add({ teamId: team });
    f.store.claimRunning(slow.id, 0);
    f.age(slow.id, 20 * MIN, 10_000);
    f.store.claimRunning(quick.id, 0);
    f.store.finishIfActive(quick.id, "done", 0);
    notifyParent({
      store: f.store,
      crons: f.crons,
      dataDir: f.dataDir,
      agent: f.store.get(quick.id)!,
    });
    expect(f.store.get(slow.id)!.status).toBe("running");
    expect(f.completions()).toHaveLength(0);
  });
});

describe("completions that land together wake the parent once", () => {
  const solo = (id: string) => agentCompletionMessage(id, "task", "done");

  test("a burst merges into the pending wake-up; it fires after the latest", () => {
    const f = fixture();
    const t0 = Date.now();
    queueCompletionWakeUp(f.crons, PARENT, solo("agent_1"));
    queueCompletionWakeUp(f.crons, PARENT, solo("agent_2"));
    queueCompletionWakeUp(f.crons, PARENT, solo("agent_3"));
    const wake = f.completions();
    expect(wake).toHaveLength(1);
    const ev = wake[0]!.systemEvent;
    expect(ev).toStartWith("Several sub-agent results arrived together (3).");
    for (const id of ["agent_1", "agent_2", "agent_3"]) expect(ev).toContain(id);
    expect(wake[0]!.nextFireMs).toBeGreaterThanOrEqual(t0 + COMPLETION_DEBOUNCE_MS);
    expect(wake[0]!.nextFireMs).toBeLessThanOrEqual(Date.now() + COMPLETION_DEBOUNCE_MS);
  });

  test("never later than the cap after the first; other events are not touched", () => {
    const f = fixture();
    const poke = f.crons.create({
      sessionKey: PARENT,
      systemEvent: "Self-poke: check on the research",
      schedule: { kind: "once", atMs: Date.now() + 5 * MIN },
    });
    queueCompletionWakeUp(f.crons, PARENT, solo("agent_1"));
    // The first one is old enough that the cap is near.
    const db = (f.crons as unknown as { db: import("bun:sqlite").Database }).db;
    const first = f.completions()[0]!;
    const createdAt = Date.now() - (COMPLETION_MAX_WAIT_MS - 10_000);
    db.query("UPDATE jobs SET created_at=? WHERE id=?").run(createdAt, first.id);
    queueCompletionWakeUp(f.crons, PARENT, solo("agent_2"));
    const wake = f.completions();
    expect(wake).toHaveLength(1);
    expect(wake[0]!.nextFireMs).toBe(createdAt + COMPLETION_MAX_WAIT_MS);
    // The completion canceled the self-poke, and did not merge into it.
    expect(f.crons.get(poke.id)!.status).toBe("canceled");
    expect(f.crons.get(poke.id)!.systemEvent).toBe("Self-poke: check on the research");
  });

  test("a wake-up about to fire is left alone", () => {
    const f = fixture();
    queueCompletionWakeUp(f.crons, PARENT, solo("agent_1"));
    const db = (f.crons as unknown as { db: import("bun:sqlite").Database }).db;
    db.query("UPDATE jobs SET next_fire_ms=?").run(Date.now() + 500);
    queueCompletionWakeUp(f.crons, PARENT, solo("agent_2"));
    expect(f.crons.listActive(PARENT)).toHaveLength(2);
  });

  test("merging keeps every block", () => {
    const three = mergeCompletionEvents(mergeCompletionEvents(solo("x1"), solo("x2")), solo("x3"));
    expect(three).toStartWith("Several sub-agent results arrived together (3).");
    expect(three.match(/\n--- \d+ ---\n/g)).toHaveLength(3);
    expect(isCompletionEvent(three)).toBe(true);
    expect(isCompletionEvent("Self-poke: x")).toBe(false);
  });
});

describe("a sub-agent's background job", () => {
  const ctxFor = (sessionKey: string) =>
    ({
      sessionKey,
      sandboxPath: tmp("bg-sb-"),
      dataDir: tmp("bg-data-"),
    }) as unknown as ToolContext;

  test("runs inline with async: there is no session to wake", async () => {
    const executors = BG_EXECUTORS as Record<string, unknown>;
    executors.test_inline_tool = async () => ({ summary: "fetched 3 pages", resultPath: null });
    try {
      const r = await dispatchOrRun("test_inline_tool", { async: true }, ctxFor("agent:agent_1"));
      expect(r.isError).toBeFalsy();
      expect(r.content[0]!.text).toContain("fetched 3 pages");
      expect(r.content[0]!.text).toContain("Ran inline");
    } finally {
      Reflect.deleteProperty(executors, "test_inline_tool");
    }
  });

  test("keeps the agent's heartbeat fresh while the tool runs", async () => {
    const f = fixture();
    const a = f.add();
    f.store.claimRunning(a.id, 0);
    f.age(a.id, 30 * MIN, 20 * MIN);
    const executors = BG_EXECUTORS as Record<string, unknown>;
    let quietDuringCall = Number.POSITIVE_INFINITY;
    executors.test_slow_tool = async () => {
      await Bun.sleep(50);
      quietDuringCall = Date.now() - (f.store.get(a.id)!.heartbeatAt ?? 0);
      return { summary: "rendered", resultPath: null };
    };
    try {
      const ctx = {
        sessionKey: `agent:${a.id}`,
        sandboxPath: tmp("bg-sb-"),
        dataDir: f.dataDir,
      } as unknown as ToolContext;
      await dispatchOrRun("test_slow_tool", { async: true }, ctx);
    } finally {
      Reflect.deleteProperty(executors, "test_slow_tool");
    }
    expect(quietDuringCall).toBeLessThan(MIN);
    expect(f.store.listStuck(AGENT_LIMITS)).toEqual([]);
  });

  test("a long tool call goes on stamping it", async () => {
    const f = fixture();
    const a = f.add();
    f.store.claimRunning(a.id, 0);
    const stamps: number[] = [];
    await withAgentHeartbeat(
      `agent:${a.id}`,
      f.dataDir,
      async () => {
        for (let i = 0; i < 4; i++) {
          await Bun.sleep(40);
          stamps.push(f.store.get(a.id)!.heartbeatAt ?? 0);
        }
      },
      15,
    );
    expect(new Set(stamps).size).toBeGreaterThan(1);
    // A session that is not a sub-agent's writes nothing.
    expect(await withAgentHeartbeat(PARENT, "/nonexistent", async () => 7)).toBe(7);
  });

  test("cannot be spawned for an agent: session", () => {
    expect(() =>
      spawnBgJob({
        store: {} as never,
        crons: {} as never,
        dataDir: "/nonexistent",
        sessionKey: "agent:agent_1",
        sandboxPath: "/nonexistent",
        toolName: "cf_markdown",
        args: {},
        configPath: "/nonexistent",
      }),
    ).toThrow("cannot start a background job");
  });
});

describe("the sub-agent model", () => {
  test("a malformed agent_model is refused before anything spawns", () => {
    expect(agentModelProblem("claude-sonnet-5.5")).toContain('"claude-sonnet-5-5"');
    expect(agentModelProblem(" ")).toBe("it is empty");
    for (const ok of ["claude-sonnet-5-5", "claude-opus-4-8[1m]", "sonnet", "gpt-5.5"]) {
      expect(agentModelProblem(ok)).toBeNull();
    }
    const f = fixture();
    const prev = process.env.EDMUND_AGENT_MODEL;
    process.env.EDMUND_AGENT_MODEL = "claude-sonnet-5.5";
    try {
      expect(() =>
        spawnAgent(f.store, f.dataDir, f.dataDir, {
          parentSessionKey: PARENT,
          task: "anything at all",
        }),
      ).toThrow("agent_model");
      expect(f.store.list()).toHaveLength(0);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "EDMUND_AGENT_MODEL");
      else process.env.EDMUND_AGENT_MODEL = prev;
    }
  });
});

describe("stopping an agent stops its CLI too", () => {
  test("the process group, not just the runner", async () => {
    const g = await processGroup();
    expect(alive(g.child)).toBe(true);
    killAgentProcess(g.leader);
    expect(await waitFor(() => !alive(g.child))).toBe(true);
  });

  test("the dashboard's cancel takes the same path as cancel_agent", async () => {
    const f = fixture();
    const app = agentsRoutes({ agents: f.store, contacts: {} as never, chatDb: {} as never });
    const pending = f.add();
    const running = f.add();
    const g = await processGroup();
    f.store.claimRunning(running.id, g.leader);
    for (const a of [pending, running]) {
      const res = await app.request(`/${a.id}/cancel`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(f.store.get(a.id)!.status).toBe("canceled");
      expect(f.store.get(a.id)!.stopReason).toBe("canceled from the dashboard");
    }
    expect(await waitFor(() => !alive(g.child))).toBe(true);
    // A finished agent stays as it was.
    expect((await app.request(`/${running.id}/cancel`, { method: "POST" })).status).toBe(200);
    expect(cancelAgent(f.store, running.id, "again")).toBe(false);
  });
});

describe("agent-runner, end to end with a fake CLI", () => {
  function run(mode: string, extra: Record<string, string> = {}) {
    const f = fixture();
    const a = f.add();
    const child = spawn("bun", [join(root, "scripts/agent-runner.ts")], {
      detached: true,
      stdio: "ignore",
      env: {
        ...(process.env as Record<string, string>),
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_AGENT_MODE: mode,
        ...extra,
        AGENT_ID: a.id,
        AGENT_TASK: a.task,
        AGENT_SANDBOX: a.sandboxPath,
        AGENT_RESULT: a.resultPath,
        AGENT_LOG: a.logPath,
        EDMUND_DATA_DIR: f.dataDir,
        EDMUND_AGENT_MODEL: "claude-test-9",
      },
    });
    if (child.pid) groups.push(child.pid);
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    return { ...f, a, child, exited };
  }
  const started = async (r: ReturnType<typeof run>) => {
    // Running, and the CLI's first message has reached the runner.
    expect(await waitFor(() => r.store.get(r.a.id)?.heartbeatAt != null)).toBe(true);
    expect(readFileSync(r.a.logPath, "utf8")).toContain("three sources");
  };
  const REASON = "stopped after 20 minutes without any output";

  test("a finished agent writes its result and wakes the parent once", async () => {
    const r = run("finish");
    expect(await r.exited).toBe(0);
    expect(r.store.get(r.a.id)!.status).toBe("done");
    expect(readFileSync(r.a.resultPath, "utf8")).toBe("final: a, b, c");
    expect(r.completions()).toHaveLength(1);
  }, 20_000);

  test("a reaped agent keeps what it found, and only the reaper reports it", async () => {
    const r = run("hang");
    await started(r);
    r.age(r.a.id, 30 * MIN, 20 * MIN);
    expect(reapStuckAgents(r.store, r.crons, r.dataDir)).toEqual([r.a.id]);
    // The group's SIGTERM reaches runner and CLI together; either may be
    // seen first, and both ways must leave the same result.
    await r.exited;
    const result = readFileSync(r.a.resultPath, "utf8");
    expect(result).toContain("found three sources so far: a, b, c");
    expect(result).toContain(REASON);
    // The reaper's report only: a second one from the runner would have been
    // merged into this same wake-up.
    expect(r.completions()).toHaveLength(1);
    expect(r.completions()[0]!.systemEvent).toStartWith("A sub-agent you spawned has finished");
  }, 20_000);

  test("SIGTERM seen first: the handler writes the partial result", async () => {
    const r = run("hang");
    await started(r);
    r.store.finishIfActive(r.a.id, "failed", null, REASON);
    process.kill(r.child.pid!, "SIGTERM"); // the runner alone; it stops its CLI
    expect(await r.exited).toBe(143);
    const result = readFileSync(r.a.resultPath, "utf8");
    expect(result).toContain("found three sources so far: a, b, c");
    expect(result).toContain(`(The agent was ${REASON}.`);
    expect(r.completions()).toHaveLength(0); // whoever settled it reports it
  }, 20_000);

  test("the CLI's exit seen first: the exit path writes the same note", async () => {
    const exitFile = join(tmp("exit-file-"), "go");
    const r = run("wait-file", { FAKE_EXIT_FILE: exitFile });
    await started(r);
    r.store.finishIfActive(r.a.id, "failed", null, REASON);
    writeFileSync(exitFile, ""); // the CLI exits on its own; the runner gets no signal
    expect(await r.exited).toBe(143);
    const result = readFileSync(r.a.resultPath, "utf8");
    expect(result).toContain("found three sources so far: a, b, c");
    expect(result).toContain(`(The agent was ${REASON}.`);
    expect(r.completions()).toHaveLength(0);
  }, 20_000);

  test("an unavailable model is named as such, not as a failed task", async () => {
    const r = run("model404");
    expect(await r.exited).toBe(1);
    expect(readFileSync(r.a.resultPath, "utf8")).toContain(
      "the configured agent model (claude-test-9) is unavailable",
    );
    expect(r.completions()[0]!.systemEvent).toContain("is unavailable");
  }, 20_000);
});

describe("every path goes through the shared settle and kill", () => {
  const files = [
    "scripts/agent-runner.ts",
    "src/agents/reaper.ts",
    "src/agents/spawn.ts",
    "src/mcp/tools/agents.ts",
    "cli/commands/agents.ts",
    "dashboard/server/routes/agents.ts",
    "dashboard/server/routes/activity.ts",
  ];
  test("no completion is scheduled around queueCompletionWakeUp, no pid killed around killAgentProcess", () => {
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8");
      expect(`${f}: ${/crons\.create\(/.test(src)}`).toBe(`${f}: false`);
      const kills = src.match(/process\.kill\(/g)?.length ?? 0;
      expect(`${f}: ${kills}`).toBe(`${f}: ${f === "src/agents/spawn.ts" ? 2 : 0}`);
      expect(`${f}: ${/\.finish\(/.test(src)}`).toBe(`${f}: false`);
    }
  });
});

describe("callers of the agent store", () => {
  // The dashboard is outside the root tsconfig, and its own no longer
  // compiles under the installed tsc: a call to a removed method reached a
  // 500 at runtime. Every file that uses AgentStore, anywhere, is read here.
  const users: string[] = [];
  const walk = (dir: string) => {
    for (const name of require("node:fs").readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${name.name}`;
      if (name.isDirectory()) {
        if (name.name !== "node_modules" && name.name !== "web" && name.name !== "user-web")
          walk(p);
      } else if (/\.tsx?$/.test(name.name)) {
        const src = readFileSync(join(root, p), "utf8");
        if (/agents\/store\.ts"/.test(src) && p !== "src/agents/store.ts") users.push(p);
      }
    }
  };
  for (const d of ["src", "scripts", "cli", "dashboard"]) walk(d);

  test("they are found", () => {
    expect(users).toContain("dashboard/server/routes/agents.ts");
    expect(users).toContain("dashboard/server/routes/activity.ts");
  });

  test("none calls a method the store no longer has, or judges stuck by other limits", () => {
    const methods = new Set(
      [
        ...readFileSync(join(root, "src/agents/store.ts"), "utf8").matchAll(
          /^ {2}(\w+)(?:<\w+>)?\(/gm,
        ),
      ].map((m) => m[1]),
    );
    let calls = 0;
    for (const p of users) {
      const src = readFileSync(join(root, p), "utf8");
      // The names this file gives an AgentStore: `x: AgentStore`,
      // `x = new AgentStore(`, and getStore() where it returns one.
      const names = new Set(
        [...src.matchAll(/(\w+)\??\s*[:=]\s*(?:new\s+)?AgentStore\b/g)].map((m) => m[1]!),
      );
      if (/getStore = \(\) =>/.test(src)) names.add("getStore()");
      for (const name of names) {
        const esc = name.replace(/[()]/g, "\\$&");
        for (const m of src.matchAll(new RegExp(`(?:^|[^\\w])${esc}\\.(\\w+)\\(`, "g"))) {
          calls++;
          expect(`${p}: ${m[1]} ${methods.has(m[1]!)}`).toBe(`${p}: ${m[1]} true`);
        }
      }
      for (const m of src.matchAll(/listStuck\(([^)]*)\)/g)) {
        expect(`${p}: ${m[1]}`).toMatch(/: (AGENT_LIMITS|limits, now)$/);
      }
    }
    expect(calls).toBeGreaterThan(20); // the scan saw the callers
  });
});
