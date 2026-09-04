import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStore } from "../src/agents/store.ts";
import type { BgJobStore } from "../src/background/store.ts";
import type { DeliverArgs } from "../src/channels/deliver.ts";
import type { Config } from "../src/config/config.ts";
import type { CronStore } from "../src/cron/store.ts";
import type { ChatDb } from "../src/imessage/db.ts";
import { sweepFallbackNotices } from "../src/recovery/fallback.ts";
import { EchoCache } from "../src/sessions/echo-cache.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import { StateStore } from "../src/sessions/store.ts";

const NOW = 1_700_000_000_000;
const DEADLINE_MS = 10 * 60_000;
/** A boot time old enough that the boot-grace window never interferes
 *  except in the test that exercises it explicitly. */
const BOOTED_LONG_AGO = NOW - 24 * 3_600_000;
const KEY = "dm:+15551234567" as SessionKey;

let dir: string;
let state: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-fallback-"));
  state = new StateStore(dir);
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function configStub(overrides: Partial<Config["recovery"]> = {}): Config {
  return {
    recovery: {
      enabled: true,
      sweep_interval_seconds: 60,
      stale_threshold_seconds: 90,
      cooldown_minutes: 30,
      max_heal_failures_before_alert: 3,
      max_age_hours: 24,
      fallback_notice_enabled: true,
      fallback_notice_after_minutes: 10,
      fallback_notice_text: "hit a snag getting back to you — still on it",
      ...overrides,
    },
    behavior: { chunk_chars: 1800, reply_threading: false },
  } as unknown as Config;
}

/** ChatDb stub whose unanswered-inbound query returns the given rowIds. */
function chatDbStub(rowIds: number[]): ChatDb {
  return {
    query: () => ({
      all: () =>
        rowIds.map((rowId) => ({
          row_id: rowId,
          msg_guid: `guid-${rowId}`,
          chat_identifier: "+15551234567",
          chat_guid: "chat-1",
          chat_style: 45,
          from_handle: "+15551234567",
          from_me: 0,
          text: "hello?",
          attributed_body: null,
          date_ns: (NOW - 978_307_200_000 - 10 * 60_000) * 1_000_000,
          service: "iMessage",
        })),
    }),
  } as unknown as ChatDb;
}

/** Session that has owed a reply since past the deadline, with the recovery
 *  sweeper having already attempted it once (the normal precondition). */
function putOwedSession(opts: { recoveryAttempted?: boolean; lastInboundMs?: number } = {}): void {
  const lastInboundMs = opts.lastInboundMs ?? NOW - DEADLINE_MS - 60_000;
  state.upsertSession({
    sessionKey: KEY,
    claudeSessionId: null,
    chatGuid: "chat-1",
    isGroup: 0,
    lastInboundMs,
    lastOutboundMs: NOW - 3_600_000,
  });
  if (opts.recoveryAttempted !== false) {
    state.markRecoveryAttempted(KEY, lastInboundMs + 120_000);
  }
}

function makeDeliver(result: { sent: number; errors: string[] }) {
  const calls: DeliverArgs[] = [];
  const deliver = async (args: DeliverArgs) => {
    calls.push(args);
    return { ...result, silenced: false };
  };
  return { calls, deliver };
}

type DepOverrides = {
  active?: string[];
  config?: Config;
  bootedAtMs?: number;
  agents?: Array<{ status: string }>;
  bgJobs?: Array<{ status: string }>;
  crons?: Array<{ nextFireMs: number; systemEvent: string }>;
};

function depsFor(
  rowIds: number[],
  deliver: ReturnType<typeof makeDeliver>["deliver"],
  o: DepOverrides = {},
) {
  return {
    config: o.config ?? configStub(),
    state,
    chatDb: chatDbStub(rowIds),
    echoes: new EchoCache(),
    activeSessions: new Set(o.active ?? []) as Set<SessionKey>,
    agents: { list: () => o.agents ?? [] } as unknown as AgentStore,
    bgJobs: { listForSession: () => o.bgJobs ?? [] } as unknown as BgJobStore,
    crons: { listActive: () => o.crons ?? [] } as unknown as CronStore,
    bootedAtMs: o.bootedAtMs ?? BOOTED_LONG_AGO,
    deliver: deliver as never,
  };
}

describe("sweepFallbackNotices", () => {
  test("sends one notice for a burst owed past the deadline and stamps it", async () => {
    putOwedSession();
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });

    await sweepFallbackNotices(depsFor([100, 101], deliver), NOW);
    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toContain("still on it");

    // Second sweep on the same burst: already stamped, no second notice.
    await sweepFallbackNotices(depsFor([100, 101], deliver), NOW + 60_000);
    expect(calls.length).toBe(1);
  });

  test("a NEW inbound after the notice re-arms it", async () => {
    putOwedSession();
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(depsFor([100], deliver), NOW);
    expect(calls.length).toBe(1);

    // A fresh message lands, also goes unanswered past the deadline, and
    // recovery has attempted it again.
    const later = NOW + 20 * 60_000;
    putOwedSession({ lastInboundMs: later - DEADLINE_MS - 1_000 });
    await sweepFallbackNotices(depsFor([100, 102], deliver), later);
    expect(calls.length).toBe(2);
  });

  test("skips bursts younger than the deadline", async () => {
    putOwedSession({ lastInboundMs: NOW - 60_000 });
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(depsFor([100], deliver), NOW);
    expect(calls.length).toBe(0);
  });

  test("boot grace: no notices until the daemon has been up a full deadline", async () => {
    putOwedSession();
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(depsFor([100], deliver, { bootedAtMs: NOW - 60_000 }), NOW);
    expect(calls.length).toBe(0);

    // Same burst, same session — once the daemon has been up past the
    // deadline the notice goes out.
    const later = NOW + DEADLINE_MS;
    await sweepFallbackNotices(depsFor([100], deliver, { bootedAtMs: NOW - 60_000 }), later);
    expect(calls.length).toBe(1);
  });

  test("requires a prior recovery attempt for this burst", async () => {
    putOwedSession({ recoveryAttempted: false });
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(depsFor([100], deliver), NOW);
    expect(calls.length).toBe(0);

    state.markRecoveryAttempted(KEY, NOW - 60_000);
    await sweepFallbackNotices(depsFor([100], deliver), NOW);
    expect(calls.length).toBe(1);
  });

  test("skips sessions mid-turn", async () => {
    putOwedSession();
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(depsFor([100], deliver, { active: [KEY] }), NOW);
    expect(calls.length).toBe(0);
  });

  test("skips when sub-agents or bg jobs are in flight (long task running)", async () => {
    putOwedSession();
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(depsFor([100], deliver, { agents: [{ status: "running" }] }), NOW);
    await sweepFallbackNotices(depsFor([100], deliver, { bgJobs: [{ status: "pending" }] }), NOW);
    expect(calls.length).toBe(0);
  });

  test("skips when a cron fire is imminent", async () => {
    putOwedSession();
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(
      depsFor([100], deliver, {
        crons: [
          {
            nextFireMs: NOW + 30_000,
            systemEvent: "[Retry 1/3] A prior turn from X did not complete.",
          },
        ],
      }),
      NOW,
    );
    expect(calls.length).toBe(0);
  });

  test("skips when a queued outbox already holds the real reply", async () => {
    putOwedSession();
    state.putOutbox({
      sessionKey: KEY,
      replyText: "the real answer",
      chatGuid: "chat-1",
      isGroup: 0,
      service: "iMessage",
      nowMs: NOW,
    });
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(depsFor([100], deliver), NOW);
    expect(calls.length).toBe(0);
  });

  test("skips when every unanswered row was already replayed (model chose silence)", async () => {
    putOwedSession();
    state.markReplayed(KEY, 100, NOW);
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(depsFor([100], deliver), NOW);
    expect(calls.length).toBe(0);
  });

  test("failed send does not stamp — next sweep retries", async () => {
    putOwedSession();
    const { calls, deliver } = makeDeliver({ sent: 0, errors: ["bridge wedged"] });
    await sweepFallbackNotices(depsFor([100], deliver), NOW);
    expect(calls.length).toBe(1);

    const { calls: calls2, deliver: deliver2 } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(depsFor([100], deliver2), NOW + 60_000);
    expect(calls2.length).toBe(1);
  });

  test("disabled flag turns the sweep off", async () => {
    putOwedSession();
    const { calls, deliver } = makeDeliver({ sent: 1, errors: [] });
    await sweepFallbackNotices(
      depsFor([100], deliver, { config: configStub({ fallback_notice_enabled: false }) }),
      NOW,
    );
    expect(calls.length).toBe(0);
  });
});
