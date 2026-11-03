import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCompletionEvent } from "../src/agents/messages.ts";
import { notifyParent } from "../src/agents/spawn.ts";
import { AgentStore } from "../src/agents/store.ts";
import { CronStore } from "../src/cron/store.ts";
import {
  IDEATION_READY_HEAD,
  firstName,
  ideationReadyMessage,
  settleIdeation,
} from "../src/ideation/settle.ts";
import { type Ideation, IdeationStore, newIdeationId } from "../src/ideation/store.ts";

const PARENT = "imessage:dm:+15550100001";
// Tuesday 2026-11-03, 03:00 Eastern: outside the default 09:00-21:00 window.
const NIGHT = Date.parse("2026-11-03T03:00:00-05:00");
const NINE_AM = Date.parse("2026-11-03T09:00:00-05:00");
// Tuesday 14:00 Eastern: inside it.
const AFTERNOON = Date.parse("2026-11-03T14:00:00-05:00");

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "ideation-settle-"));
  const store = new IdeationStore(dataDir);
  const agents = new AgentStore(dataDir);
  const crons = new CronStore(dataDir);
  const addAgent = () => {
    const sb = join(dataDir, "sb", `a${Math.random().toString(36).slice(2)}`);
    mkdirSync(sb, { recursive: true });
    return agents.create(
      { parentSessionKey: PARENT, task: "build a page", role: "ideation" },
      { sandboxPath: sb, resultPath: join(sb, "result.md"), logPath: join(sb, "agent.log") },
    );
  };
  const addIdeation = (agentId: string, ready: boolean): Ideation => {
    const id = newIdeationId();
    store.create({
      id,
      sessionKey: PARENT,
      thread: "the night sky",
      threadKey: "the night sky",
      title: "Sunset Compass",
      pitch: "Where the sun sets from each of your spots.",
      why: "Asked on eight days.",
      brief: "Build it.",
      evidence: [1, 2, 3],
      days: ["2026-10-24", "2026-10-27", "2026-11-01"],
      createdMs: 1_000,
    });
    store.setAgent(id, agentId);
    if (ready) store.markReady(id, 2_000, `https://pages.example.com/i/${id}/`);
    return store.get(id) as Ideation;
  };
  const created: Array<{ sessionKey: string; systemEvent: string; atMs: number }> = [];
  const fakeCrons = {
    create: (i: {
      sessionKey: string;
      systemEvent: string;
      schedule: { kind: string; atMs?: number };
    }) => {
      created.push({
        sessionKey: i.sessionKey,
        systemEvent: i.systemEvent,
        atMs: i.schedule.atMs ?? 0,
      });
      return {} as ReturnType<CronStore["create"]>;
    },
  };
  const deps = (nowMs: number) => ({
    dataDir,
    crons: fakeCrons,
    prefsFor: () => null,
    nameFor: () => "Sam",
    store,
    nowMs,
  });
  return { dataDir, store, agents, crons, addAgent, addIdeation, created, deps };
}

describe("settleIdeation", () => {
  test("a build that stopped without publishing is failed, and nobody is told", () => {
    const f = fixture();
    const a = f.addAgent();
    const i = f.addIdeation(a.id, false);
    expect(settleIdeation(f.deps(AFTERNOON), { id: a.id, status: "failed" })).toBe(true);
    expect(f.store.get(i.id)?.status).toBe("failed");
    expect(f.created).toEqual([]);
  });

  test("a published page is offered to Edmund once, at the next hour they accept messages", () => {
    const f = fixture();
    const a = f.addAgent();
    const i = f.addIdeation(a.id, true);
    expect(settleIdeation(f.deps(NIGHT), { id: a.id, status: "done" })).toBe(true);
    expect(settleIdeation(f.deps(NIGHT), { id: a.id, status: "done" })).toBe(true);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]?.atMs).toBe(NINE_AM);
    expect(f.created[0]?.sessionKey).toBe(PARENT);
    const ev = f.created[0]?.systemEvent ?? "";
    expect(ev).toStartWith(IDEATION_READY_HEAD);
    expect(ev).toContain(`https://pages.example.com/i/${i.id}/`);
    expect(ev).toContain("KEEP_QUIET");
    expect(ev).toContain("Oct 24, Oct 27, Nov 1");
    expect(isCompletionEvent(ev)).toBe(false);
  });

  test("inside their hours it waits only long enough for a reply in flight", () => {
    const f = fixture();
    const a = f.addAgent();
    f.addIdeation(a.id, true);
    settleIdeation(f.deps(AFTERNOON), { id: a.id, status: "done" });
    expect(f.created[0]?.atMs).toBe(AFTERNOON + 30_000);
  });

  test("an agent that built nothing is not an ideation", () => {
    const f = fixture();
    const a = f.addAgent();
    expect(settleIdeation(f.deps(AFTERNOON), { id: a.id, status: "done" })).toBe(false);
  });
});

describe("notifyParent routes ideation builds away from the completion wake-up", () => {
  test("a failed build queues no completion wake-up", () => {
    const f = fixture();
    const a = f.addAgent();
    const i = f.addIdeation(a.id, false);
    f.agents.finishIfActive(a.id, "failed", 1);
    notifyParent({
      store: f.agents,
      crons: f.crons,
      dataDir: f.dataDir,
      agent: f.agents.get(a.id)!,
      log: () => {},
    });
    expect(f.crons.listActive(PARENT).filter((j) => isCompletionEvent(j.systemEvent))).toEqual([]);
    expect(f.store.get(i.id)?.status).toBe("failed");
  });

  test("a published build queues the ready message instead", () => {
    const f = fixture();
    const a = f.addAgent();
    f.addIdeation(a.id, true);
    f.agents.finishIfActive(a.id, "done", 0);
    notifyParent({
      store: f.agents,
      crons: f.crons,
      dataDir: f.dataDir,
      agent: f.agents.get(a.id)!,
      log: () => {},
    });
    const jobs = f.crons.listActive(PARENT);
    expect(jobs.filter((j) => isCompletionEvent(j.systemEvent))).toEqual([]);
    expect(jobs.filter((j) => j.systemEvent.startsWith(IDEATION_READY_HEAD))).toHaveLength(1);
  });

  test("an ordinary agent still gets its completion wake-up", () => {
    const f = fixture();
    const a = f.addAgent();
    f.agents.finishIfActive(a.id, "done", 0);
    notifyParent({
      store: f.agents,
      crons: f.crons,
      dataDir: f.dataDir,
      agent: f.agents.get(a.id)!,
      log: () => {},
    });
    expect(f.crons.listActive(PARENT).filter((j) => isCompletionEvent(j.systemEvent))).toHaveLength(
      1,
    );
  });
});

describe("the ready message", () => {
  test("uses a first name, never a phone number", () => {
    expect(firstName("Sam Rivers")).toBe("Sam");
    expect(firstName("+15550100001")).toBe("them");
    expect(firstName(null)).toBe("them");
  });

  test("names what it is and why", () => {
    const f = fixture();
    const a = f.addAgent();
    const i = f.addIdeation(a.id, true);
    const msg = ideationReadyMessage(i, "Sam");
    expect(msg).toContain('for Sam, unasked, because they keep coming back to "the night sky"');
    expect(msg).toContain("Sunset Compass");
  });
});
