import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/cron/store.ts";

let dir: string;
let store: CronStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-cron-"));
  store = new CronStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("CronStore", () => {
  test("create + get round-trips a one-shot job", () => {
    const future = Date.now() + 60_000;
    const job = store.create({
      sessionKey: "imessage:dm:+1555",
      systemEvent: "Reminder: stand up",
      schedule: { kind: "once", atMs: future },
    });
    expect(job.id).toMatch(/^job_/);
    const got = store.get(job.id)!;
    expect(got.systemEvent).toBe("Reminder: stand up");
    expect(got.schedule).toEqual({ kind: "once", atMs: future });
    expect(got.nextFireMs).toBe(future);
  });

  test("listActive / nextDue order by next fire", () => {
    const now = Date.now();
    const late = store.create({
      sessionKey: "s",
      systemEvent: "late",
      schedule: { kind: "once", atMs: now + 9_000 },
    });
    const soon = store.create({
      sessionKey: "s",
      systemEvent: "soon",
      schedule: { kind: "once", atMs: now + 1_000 },
    });
    expect(store.listActive().map((j) => j.id)).toEqual([soon.id, late.id]);
    expect(store.nextDue()?.id).toBe(soon.id);
  });

  test("a row with a corrupt schedule_json is quarantined, not crashed on", () => {
    const good = store.create({
      sessionKey: "s",
      systemEvent: "good",
      schedule: { kind: "once", atMs: Date.now() + 5_000 },
    });
    // Reach into the raw DB and corrupt one row + insert a totally bogus one.
    const raw = new Database(join(dir, "cron.db"));
    raw.query("UPDATE jobs SET schedule_json = ? WHERE id = ?").run("not json at all", good.id);
    raw
      .query(
        "INSERT INTO jobs(id, session_key, system_event, schedule_json, next_fire_ms, created_at, last_fired_ms, status) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        "job_bogus",
        "s",
        "bogus",
        JSON.stringify({ kind: "weird" }),
        Date.now() + 1,
        Date.now(),
        null,
        "active",
      );
    raw.close();

    // None of these should throw; the corrupt rows just vanish from results.
    expect(store.get(good.id)).toBeNull();
    expect(store.get("job_bogus")).toBeNull();
    expect(store.nextDue()).toBeNull();
    expect(store.listActive()).toEqual([]);

    // And they've been flipped to 'canceled' in the DB (won't be retried).
    const check = new Database(join(dir, "cron.db"));
    const byId = new Map(
      (
        check.query("SELECT id, status FROM jobs").all() as Array<{ id: string; status: string }>
      ).map((r) => [r.id, r.status]),
    );
    check.close();
    expect(byId.get(good.id)).toBe("canceled");
    expect(byId.get("job_bogus")).toBe("canceled");
  });

  test("cancel + markFired", () => {
    const now = Date.now();
    const job = store.create({
      sessionKey: "s",
      systemEvent: "x",
      schedule: { kind: "once", atMs: now + 1_000 },
    });
    const fired = store.markFired(job, now + 1_000);
    expect(fired.status).toBe("done"); // one-shot is done after firing
    expect(store.get(job.id)?.status).toBe("done");

    const recurring = store.create({
      sessionKey: "s",
      systemEvent: "y",
      schedule: { kind: "cron", expr: "0 9 * * *" },
    });
    expect(store.cancel(recurring.id)).toBe(true);
    expect(store.cancel(recurring.id)).toBe(false); // already canceled
    expect(store.get(recurring.id)?.status).toBe("canceled");
  });
});
