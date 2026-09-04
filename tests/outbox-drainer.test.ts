import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config/config.ts";
import { EchoCache } from "../src/sessions/echo-cache.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import { StateStore } from "../src/sessions/store.ts";

/** Delivery outcome the fake `deliverReply` returns next. */
let outcome: { sent: number; sentChunks: string[]; errors: string[]; silenced: boolean } = {
  sent: 1,
  sentChunks: ["hi"],
  errors: [],
  silenced: false,
};
// Injected rather than mock.module'd: replacing the module would swap out
// deliverReply for every other test in the run, which broke the real
// deliver-routing suite the first time this was written that way.
let lastArgs: { to: string; chatGuid?: string } | null = null;
const deliverReply = mock((args: { to: string; chatGuid?: string }) => {
  lastArgs = args;
  return Promise.resolve(outcome);
});

/** Minimal chat.db + contacts, enough for chatGuidsForSession to answer. */
const fakeChatDb = { query: () => ({ all: () => [{ guid: CHAT }] }) } as never;
const fakeContacts = { allKnownHandles: () => [], canon: (h: string) => h } as never;

const { drainOutbox, resetDrainState, STUCK_ALERT_AFTER_MS, HEAL_ESCALATE_AFTER_MS } = await import(
  "../src/recovery/outbox-drainer.ts"
);

/** The drainer's backoff is module state; nudge the row's timestamp to make
 *  the entry due again rather than reaching into internals. */
function nextTryReset() {
  state.clearOutbox(KEY);
  queue(Date.now() - (HEAL_ESCALATE_AFTER_MS + 60_000));
}

const KEY = "dm:+15551234567" as SessionKey;
const CHAT = "any;-;+15551234567";
const CONFIG = {} as Config;

let dir: string;
let state: StateStore;

function queue(nowMs = Date.now(), chatGuid = CHAT) {
  state.putOutbox({
    sessionKey: KEY,
    replyText: "the reply that never went",
    chatGuid,
    isGroup: 0,
    service: "iMessage",
    nowMs,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-drain-"));
  state = new StateStore(dir);
  deliverReply.mockClear();
  lastArgs = null;
  resetDrainState();
  outcome = { sent: 1, sentChunks: ["hi"], errors: [], silenced: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("outbox drainer", () => {
  test("delivers a queued reply without waiting for the person to write again", async () => {
    queue();
    expect(state.getOutbox(KEY)).not.toBeNull();

    const res = await drainOutbox({
      state,
      config: CONFIG,
      echoes: new EchoCache(),
      deliver: deliverReply as never,
    });

    expect(res.sent).toBe(1);
    expect(deliverReply).toHaveBeenCalledTimes(1);
    // The whole point: nothing is left for the next inbound to drag along.
    expect(state.getOutbox(KEY)).toBeNull();
  });

  test("a still-failing reply stays queued rather than being dropped", async () => {
    queue();
    outcome = { sent: 0, sentChunks: [], errors: ["RpcTimeoutError: nope"], silenced: false };

    const res = await drainOutbox({
      state,
      config: CONFIG,
      echoes: new EchoCache(),
      deliver: deliverReply as never,
    });

    expect(res.sent).toBe(0);
    expect(res.dropped).toBe(0);
    // Transient means keep it: the next pass is ten seconds away.
    expect(state.getOutbox(KEY)).not.toBeNull();
  });

  test("a permanently undeliverable reply is dropped instead of retried forever", async () => {
    queue();
    outcome = { sent: 0, sentChunks: [], errors: ["BadRequestError: bad file"], silenced: false };

    const res = await drainOutbox({
      state,
      config: CONFIG,
      echoes: new EchoCache(),
      deliver: deliverReply as never,
    });

    expect(res.dropped).toBe(1);
    expect(state.getOutbox(KEY)).toBeNull();
  });

  test("an empty queue is a no-op — a drain never costs a send", async () => {
    const res = await drainOutbox({
      state,
      config: CONFIG,
      echoes: new EchoCache(),
      deliver: deliverReply as never,
    });
    expect(res).toEqual({ attempted: 0, sent: 0, dropped: 0 });
    expect(deliverReply).not.toHaveBeenCalled();
  });

  test("a repeatedly failing reply backs off instead of retrying every tick", async () => {
    // 2,358 pointless sends were burned on one poisoned chat at a flat 10s
    // before this existed.
    queue();
    outcome = { sent: 0, sentChunks: [], errors: ["RpcTimeoutError: nope"], silenced: false };
    const deps = {
      state,
      config: CONFIG,
      echoes: new EchoCache(),
      deliver: deliverReply as never,
      heal: async () => undefined,
    };

    await drainOutbox(deps);
    expect(deliverReply).toHaveBeenCalledTimes(1);
    // Immediately after a failure the entry is not due again.
    await drainOutbox(deps);
    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(state.getOutbox(KEY)).not.toBeNull();
  });

  test("a long-stuck reply asks for exactly one registry rebuild", async () => {
    // A relabelled chat object cannot be resent past; the only cure is a
    // registry rebuild. Once per episode — not once per tick.
    queue(Date.now() - (HEAL_ESCALATE_AFTER_MS + 60_000));
    outcome = { sent: 0, sentChunks: [], errors: ["RpcTimeoutError: nope"], silenced: false };
    let heals = 0;
    const deps = {
      state,
      config: CONFIG,
      echoes: new EchoCache(),
      deliver: deliverReply as never,
      heal: async () => {
        heals += 1;
      },
    };

    await drainOutbox(deps);
    nextTryReset();
    await drainOutbox(deps);
    expect(heals).toBe(1);
  });

  test("a reply queued moments ago does not alert the operator", async () => {
    // The old behaviour announced "message could not be delivered" about eight
    // seconds in, for messages that then arrived by themselves. Nothing is
    // lost while the drainer still holds it, so a fresh failure stays quiet.
    queue();
    outcome = { sent: 0, sentChunks: [], errors: ["RpcTimeoutError: nope"], silenced: false };

    await drainOutbox({
      state,
      config: CONFIG,
      echoes: new EchoCache(),
      deliver: deliverReply as never,
    });

    expect(state.getOutbox(KEY)).not.toBeNull();
    expect(STUCK_ALERT_AFTER_MS).toBeGreaterThan(60_000);
  });

  test("a reply queued with no chat row is pinned to one before it is retried", async () => {
    // The bug this exists for: a row stored with chat_guid = '' was retried by
    // bare handle, which on this account resolves to the note-to-self thread.
    // 67 consecutive refusals on one conversation, ten seconds apart, each one
    // re-inflicting the registry corruption it was retrying because of.
    queue(Date.now(), "");

    await drainOutbox({
      state,
      config: CONFIG,
      echoes: new EchoCache(),
      deliver: deliverReply as never,
      chatDb: fakeChatDb,
      contacts: fakeContacts,
    });

    expect(lastArgs).not.toBeNull();
    expect(lastArgs!.chatGuid).toBe(CHAT);
    expect(lastArgs!.chatGuid).not.toBe("");
  });

  test("the pin is written back, so the next drain starts from a chat row", async () => {
    queue(Date.now(), "");
    outcome = { sent: 0, sentChunks: [], errors: ["RpcTimeoutError: nope"], silenced: false };

    await drainOutbox({
      state,
      config: CONFIG,
      echoes: new EchoCache(),
      deliver: deliverReply as never,
      chatDb: fakeChatDb,
      contacts: fakeContacts,
    });

    expect(state.getOutbox(KEY)?.chatGuid).toBe(CHAT);
  });

  test("each failed drain counts an attempt, so the backoff can grow", async () => {
    // attempt_count moved only in putOutbox, which a retry never calls. Every
    // backoff was therefore computed from the same number and came out the
    // same size — an exponential schedule that was flat in practice. The
    // drainer's own log read `attempts=1` after dozens of retries.
    queue();
    outcome = { sent: 0, sentChunks: [], errors: ["RpcTimeoutError: nope"], silenced: false };
    const deps = {
      state,
      config: CONFIG,
      echoes: new EchoCache(),
      deliver: deliverReply as never,
      heal: async () => undefined,
    };

    const before = state.getOutbox(KEY)!.attemptCount;
    await drainOutbox(deps);
    expect(state.getOutbox(KEY)!.attemptCount).toBe(before + 1);
  });
});
