/**
 * Agent results reach a conversation on a call at once. Texting debounces a
 * completion 20 s so a burst becomes one reply; on the first live call that,
 * plus the turn in flight, left the caller waiting 27 s, and reading the
 * result took one more model round trip before Edmund could say anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentCompletionMessage,
  finishedResult,
  isCompletionEvent,
  queueCompletionWakeUp,
  withInlineResults,
} from "../src/agents/messages.ts";
import { CronStore } from "../src/cron/store.ts";

const DM = "imessage:dm:+15550100001";
const OTHER = "imessage:dm:+15550100002";

let dir: string;
let crons: CronStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-wakeups-"));
  crons = new CronStore(dir);
});
afterEach(() => {
  crons.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("expedite", () => {
  test("a debounced completion fires now, rewritten once", () => {
    queueCompletionWakeUp(crons, DM, agentCompletionMessage("agent_1", "look it up", "done"));
    const [queued] = crons.listActive(DM);
    expect(queued!.nextFireMs).toBeGreaterThan(Date.now() + 15_000);

    let rewrites = 0;
    const rewrite = (event: string) => {
      rewrites += 1;
      return `${event}\n[inline]`;
    };
    expect(crons.expedite(DM, isCompletionEvent, rewrite)).toBe(1);
    const [due] = crons.listActive(DM);
    expect(due!.nextFireMs).toBeLessThanOrEqual(Date.now());
    expect(due!.systemEvent.endsWith("[inline]")).toBe(true);

    // The next poll finds nothing left in the future: no second rewrite.
    expect(crons.expedite(DM, isCompletionEvent, rewrite)).toBe(0);
    expect(rewrites).toBe(1);
  });

  test("leaves other wake-ups and other conversations alone", () => {
    const reminder = crons.create({
      sessionKey: DM,
      systemEvent: "Reminder: stand up",
      schedule: { kind: "once", atMs: Date.now() + 60_000 },
    });
    queueCompletionWakeUp(crons, OTHER, agentCompletionMessage("agent_2", "x", "done"));
    expect(crons.expedite(DM, isCompletionEvent)).toBe(0);
    expect(crons.get(reminder.id)!.nextFireMs).toBeGreaterThan(Date.now() + 50_000);
    expect(crons.listActive(OTHER)[0]!.nextFireMs).toBeGreaterThan(Date.now() + 15_000);
  });
});

describe("results inline", () => {
  const event = agentCompletionMessage("agent_1", "look it up", "done");

  test("each finished agent's result is written into the wake-up, once", () => {
    const inlined = withInlineResults(event, (id) =>
      id === "agent_1" ? { status: "done", body: "Three countries issued new guidance." } : null,
    );
    expect(inlined).toContain("Three countries issued new guidance.");
    expect(inlined).toContain("no need to read_agent_result");
    expect(withInlineResults(inlined, () => ({ status: "done", body: "again" }))).toBe(inlined);
  });

  test("nothing readable leaves the event as it was", () => {
    expect(withInlineResults(event, () => null)).toBe(event);
  });

  test("a long result is cut short", () => {
    const inlined = withInlineResults(
      event,
      () => ({ status: "done", body: "x".repeat(10_000) }),
      100,
    );
    expect(inlined.length).toBeLessThan(event.length + 400);
  });

  test("only this conversation's finished agents are read, and each is marked delivered", () => {
    const resultPath = join(dir, "result.md");
    writeFileSync(resultPath, "the answer");
    const delivered: string[] = [];
    const agents = {
      get: (id: string) =>
        ({
          agent_done: { id, parentSessionKey: DM, status: "done", resultPath },
          agent_running: { id, parentSessionKey: DM, status: "running", resultPath },
        })[id] as never,
      markDelivered: (id: string) => void delivered.push(id),
    };
    expect(finishedResult(agents, "agent_done", DM)).toEqual({
      status: "done",
      body: "the answer",
    });
    expect(finishedResult(agents, "agent_done", OTHER)).toBeNull();
    expect(finishedResult(agents, "agent_running", DM)).toBeNull();
    expect(delivered).toEqual(["agent_done"]);
  });
});
