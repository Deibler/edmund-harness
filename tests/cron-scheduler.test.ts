/**
 * The cron drain used to await each fire, a whole model turn, before the
 * next: on 2026-09-25 one 38-minute bg-job-done turn in a DM held the
 * mirror's severe-weather check until it was skipped as 34 minutes stale.
 * Sessions now fire independently; one session's fires still run in order.
 */
import { describe, expect, test } from "bun:test";
import { Scheduler } from "../src/cron/scheduler.ts";
import type { CronJob } from "../src/cron/types.ts";

function job(id: string, sessionKey: string, nextFireMs = Date.now() - 1000): CronJob {
  return {
    id,
    sessionKey,
    systemEvent: id,
    schedule: { kind: "once", atMs: nextFireMs },
    nextFireMs,
    createdAt: 0,
    lastFiredMs: null,
    status: "active",
    gracePeriodMs: null,
    attachImages: null,
    harnessWritten: true,
  };
}

/** Once-jobs in memory: nextDue is the earliest active one, markFired ends it. */
function store(jobs: CronJob[]) {
  return {
    nextDue: () =>
      jobs.filter((j) => j.status === "active").sort((a, b) => a.nextFireMs - b.nextFireMs)[0] ??
      null,
    markFired: (j: CronJob, now: number) => {
      const row = jobs.find((x) => x.id === j.id)!;
      row.status = "done";
      row.lastFiredMs = now;
    },
  };
}

/** An onFire whose fires stay open until released, recording start order. */
function heldFires() {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const onFire = (j: CronJob) =>
    new Promise<void>((r) => {
      started.push(j.id);
      release.set(j.id, r);
    });
  return { started, onFire, release: (id: string) => release.get(id)?.() };
}

const tick = () => Bun.sleep(5);

describe("cron scheduler", () => {
  test("a long fire in one session does not hold up another session's job", async () => {
    const f = heldFires();
    const s = new Scheduler({
      store: store([
        job("dm-long", "imessage:dm:+15550003001", Date.now() - 2000),
        job("mirror-weather", "mirror:pi-4"),
      ]),
      onFire: f.onFire,
    });
    s.start();
    await tick();
    expect(f.started).toEqual(["dm-long", "mirror-weather"]);
    f.release("dm-long");
    f.release("mirror-weather");
    s.stop();
  });

  test("one session's fires run one after another, in due order", async () => {
    const f = heldFires();
    const key = "imessage:dm:+15550003002";
    const s = new Scheduler({
      store: store([job("second", key, Date.now() - 1000), job("first", key, Date.now() - 2000)]),
      onFire: f.onFire,
    });
    s.start();
    await tick();
    expect(f.started).toEqual(["first"]);
    f.release("first");
    await tick();
    expect(f.started).toEqual(["first", "second"]);
    f.release("second");
    s.stop();
  });

  test("a poke mid-fire never fires a job twice", async () => {
    const f = heldFires();
    const s = new Scheduler({
      store: store([job("a", "s1"), job("b", "s2"), job("c", "s1")]),
      onFire: f.onFire,
    });
    s.start();
    await tick();
    s.poke();
    s.poke();
    await tick();
    f.release("a");
    await tick();
    s.poke();
    await tick();
    expect(f.started.sort()).toEqual(["a", "b", "c"]);
    for (const id of ["b", "c"]) f.release(id);
    s.stop();
  });

  test("a fire that throws is reported and its session's next fire still runs", async () => {
    const errors: unknown[] = [];
    const fired: string[] = [];
    const s = new Scheduler({
      store: store([job("boom", "s1", Date.now() - 2000), job("after", "s1")]),
      onFire: async (j) => {
        fired.push(j.id);
        if (j.id === "boom") throw new Error("model down");
      },
      onError: (e) => errors.push(e),
    });
    s.start();
    await tick();
    expect(fired).toEqual(["boom", "after"]);
    expect(errors).toHaveLength(1);
    s.stop();
  });
});
