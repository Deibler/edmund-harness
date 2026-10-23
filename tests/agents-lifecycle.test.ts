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
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  agentModelProblem,
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
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PARENT = "imessage:dm:+15550100021";
const MIN = 60_000;

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
    expect(f.store.finishIfActive(a.id, "canceled", null, "canceled by its parent")).toBe(true);
    expect(f.store.claimRunning(a.id, 1)).toBe(false);
    expect(f.store.finishIfActive(a.id, "done", 0)).toBe(false);
    expect(f.store.get(a.id)!.status).toBe("canceled");
  });
});

describe("a team reports once", () => {
  test("two members settling at the same moment send one team-done", () => {
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
    const leader = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const childPid = Number(
      await new Promise<string>((r) => leader.stdout.once("data", (b) => r(String(b)))),
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(childPid)).toBe(true);
    killAgentProcess(leader.pid!);
    for (let i = 0; i < 50 && alive(childPid); i++) await Bun.sleep(20);
    expect(alive(childPid)).toBe(false);
  });
});

describe("agent-runner, end to end with a fake CLI", () => {
  const bin = tmp("fake-agent-bin-");
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures/fake-claude-agent.ts")}" "$@"\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);

  function run(mode: string) {
    const f = fixture();
    const a = f.add();
    const child = spawn("bun", [join(root, "scripts/agent-runner.ts")], {
      detached: true,
      stdio: "ignore",
      env: {
        ...(process.env as Record<string, string>),
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_AGENT_MODE: mode,
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
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(20);
    return cond();
  };

  test("a finished agent writes its result and wakes the parent once", async () => {
    const r = run("finish");
    expect(await r.exited).toBe(0);
    expect(r.store.get(r.a.id)!.status).toBe("done");
    expect(readFileSync(r.a.resultPath, "utf8")).toBe("final: a, b, c");
    expect(r.completions()).toHaveLength(1);
  }, 20_000);

  test("a reaped agent keeps what it found, and only the reaper reports it", async () => {
    const r = run("hang");
    expect(await waitFor(() => r.store.get(r.a.id)?.status === "running")).toBe(true);
    // The CLI's first message reaches the runner, which stamps the heartbeat.
    expect(await waitFor(() => r.store.get(r.a.id)?.heartbeatAt != null)).toBe(true);
    expect(readFileSync(r.a.logPath, "utf8")).toContain("three sources");
    r.age(r.a.id, 30 * MIN, 20 * MIN);
    expect(reapStuckAgents(r.store, r.crons, r.dataDir)).toEqual([r.a.id]);
    expect(await r.exited).toBe(143);
    const result = readFileSync(r.a.resultPath, "utf8");
    expect(result).toContain("found three sources so far: a, b, c");
    expect(result).toContain("stopped after 20 minutes without any output");
    // The reaper's report only: a second one from the runner would have been
    // merged into this same wake-up.
    expect(r.completions()).toHaveLength(1);
    expect(r.completions()[0]!.systemEvent).toStartWith("A sub-agent you spawned has finished");
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
