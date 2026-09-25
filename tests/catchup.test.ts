import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractOrphanAcks, groupBacklog, runCatchUp } from "../src/boot/catchup.ts";
import type { Deps } from "../src/channels/deps.ts";
import type { TurnOpts } from "../src/channels/turn.ts";
import type { Config } from "../src/config/config.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { EchoCache } from "../src/sessions/echo-cache.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import { SessionLocks } from "../src/sessions/locks.ts";
import type { StateStore } from "../src/sessions/store.ts";

function cfg(): Config {
  return {
    self: { handles: ["+19990000000"] },
    identity: { names: ["edmund", "claude"] },
    allowlist: { dm: [], groups: [] },
    security: { open_dm_allowlist: true, open_group_allowlist: true }, // empty => accept all DMs
    trading: { enabled: false, handles: [], trigger_names: [] }, // trading off in these tests
  } as unknown as Config;
}

/** Minimal StateStore stub: just recordRouting (a no-op) + the cursor KV that
 *  tradingGate touches when trading is enabled (unused here since it's off). */
function fakeState() {
  const kv = new Map<string, number>();
  return {
    recordRouting: () => {},
    getCursor: (n: string, f: number) => kv.get(n) ?? f,
    setCursor: (n: string, v: number) => kv.set(n, v),
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any;
}

let rowId = 1;
function dm(handle: string, text: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    rowId: rowId++,
    msgGuid: `g-${rowId}`,
    chatIdentifier: handle,
    chatGuid: `iMessage;-;${handle}`,
    isGroup: false,
    fromHandle: handle,
    fromMe: false,
    text,
    timestampMs: 0,
    attachments: [],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
    ...over,
  };
}

function deps(echoes = new EchoCache()): Pick<Deps, "config" | "echoes" | "contacts" | "state"> {
  return { config: cfg(), echoes, contacts: undefined, state: fakeState() } as Pick<
    Deps,
    "config" | "echoes" | "contacts" | "state"
  >;
}

describe("recovery catch-up grouping (no-spam guarantee)", () => {
  test("coalesces a backlog into ONE bucket per chat, not one per message", () => {
    const backlog = [
      dm("+15550000001", "hey"),
      dm("+15550000001", "you there?"),
      dm("+15550000001", "edmund?"),
      dm("+15550000002", "weather?"),
      dm("+15550000002", "?"),
    ];
    const groups = groupBacklog(backlog, deps());
    // Two chats => two turns total, NOT five. This is what stops the recovery group-chat spam.
    expect(groups.size).toBe(2);
    const sizes = [...groups.values()].map((b) => b.length).sort((a, b) => a - b);
    expect(sizes).toEqual([2, 3]); // every message preserved, just grouped
  });

  test("drops echoes (the daemon's own sent messages) from the backlog", () => {
    const echoes = new EchoCache();
    const own = "this is my own outbound text";
    echoes.recordSent(own, "g-own");
    const groups = groupBacklog([dm("+15550000003", own)], deps(echoes));
    expect(groups.size).toBe(0);
  });

  test("empty backlog yields no turns", () => {
    expect(groupBacklog([], deps()).size).toBe(0);
  });
});

describe("extractOrphanAcks", () => {
  const KEY = "imessage:dm:+15550001111";

  function fakeState(
    acks: Array<{ rowId: number; sessionKey: string; entryJson: string; createdMs: number }>,
  ): StateStore {
    // Minimal StateStore stub: just the inbound_ack operations.
    // Wrap in a simple state object so extractOrphanAcks can call the
    // four methods it uses.
    const stateAcks = [...acks]; // mutable copy
    return {
      listInboundAcks() {
        return stateAcks.map((a) => ({ ...a }));
      },
      deleteInboundAck(rowId: number) {
        const i = stateAcks.findIndex((a) => a.rowId === rowId);
        if (i >= 0) stateAcks.splice(i, 1);
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
  }

  function ack(
    rowId: number,
    sessionKey: string,
    json: Record<string, unknown>,
    createdMs: number = Date.now(),
  ) {
    return { rowId, sessionKey, entryJson: JSON.stringify(json), createdMs };
  }

  test("returns empty map when no acks exist", () => {
    const result = extractOrphanAcks({ state: fakeState([]), staleCutoffMs: 0, startCursor: 0 });
    expect(result.size).toBe(0);
  });

  test("groups acks by session key", () => {
    const state = fakeState([
      ack(101, KEY, { rowId: 101, chatGuid: "g", chatIdentifier: "h", fromHandle: "h", text: "a" }),
      ack(102, KEY, { rowId: 102, chatGuid: "g", chatIdentifier: "h", fromHandle: "h", text: "b" }),
      ack(201, "other", {
        rowId: 201,
        chatGuid: "g",
        chatIdentifier: "h",
        fromHandle: "h",
        text: "c",
      }),
    ]);
    // cursor already past every row = all are true orphans (the crash the table exists for)
    const result = extractOrphanAcks({ state, staleCutoffMs: 0, startCursor: 999 });
    expect(result.size).toBe(2);
    expect(result.get(KEY)!.length).toBe(2);
    expect(result.get("other")!.length).toBe(1);
  });

  test("excludes rows with rowId > startCursor (chat.db backlog covers them)", () => {
    const state = fakeState([
      ack(100, KEY, {
        rowId: 100,
        chatGuid: "g",
        chatIdentifier: "h",
        fromHandle: "h",
        text: "orphan",
      }),
      ack(101, KEY, {
        rowId: 101,
        chatGuid: "g",
        chatIdentifier: "h",
        fromHandle: "h",
        text: "in-backlog",
      }),
    ]);
    const result = extractOrphanAcks({ state, staleCutoffMs: 0, startCursor: 100 });
    // Only rowId 100 survives: the cursor is already past it, so the chat.db
    // backlog (which reads rows > 100) can't recover it — that's the
    // debounce-window crash this table exists for. Row 101 is in the backlog
    // and replaying it here too would double-deliver.
    expect(result.get(KEY)!.length).toBe(1);
    expect(result.get(KEY)![0]!.rowId).toBe(100);
    // the backlog-covered ack row is cleaned up, not left to rot
    expect(state.listInboundAcks().some((a) => a.rowId === 101)).toBe(false);
  });

  test("drops stale acks beyond cut-off", () => {
    const old = Date.now() - 100_000_000; // ~28 hours ago
    const state = fakeState([
      ack(
        1,
        KEY,
        { rowId: 1, chatGuid: "g", chatIdentifier: "h", fromHandle: "h", text: "stale" },
        old,
      ),
      ack(2, KEY, { rowId: 2, chatGuid: "g", chatIdentifier: "h", fromHandle: "h", text: "fresh" }),
    ]);
    const result = extractOrphanAcks({ state, staleCutoffMs: old + 1, startCursor: 999 });
    expect(result.get(KEY)!.length).toBe(1);
    expect(result.get(KEY)![0]!.rowId).toBe(2);
  });

  test("drops unparseable acks", () => {
    const state = fakeState([
      ack(1, KEY, { rowId: 1, chatGuid: "g", chatIdentifier: "h", fromHandle: "h", text: "ok" }),
      { rowId: 2, sessionKey: KEY, entryJson: "garbage", createdMs: Date.now() },
    ]);
    const result = extractOrphanAcks({ state, staleCutoffMs: 0, startCursor: 999 });
    expect(result.get(KEY)!.length).toBe(1);
    expect(result.get(KEY)![0]!.rowId).toBe(1);
  });
});

describe("runCatchUp hands the watcher its cursor before any turn finishes", () => {
  const A = "+15550002001";
  const B = "+15550002002";
  const keyA = "imessage:dm:+15550002001" as SessionKey;
  const keyB = "imessage:dm:+15550002002" as SessionKey;

  function catchUpDeps(acks: Array<{ rowId: number; sessionKey: string; entryJson: string }> = []) {
    const written: number[] = [];
    const stored = acks.map((a) => ({ ...a, createdMs: Date.now() }));
    const state = {
      recordRouting: () => {},
      listInboundAcks: () => stored.map((a) => ({ ...a })),
      deleteInboundAck: (rowId: number) => {
        const i = stored.findIndex((a) => a.rowId === rowId);
        if (i >= 0) stored.splice(i, 1);
      },
      writeInboundAck: (rowId: number) => written.push(rowId),
    };
    const config = {
      ...cfg(),
      behavior: { durable_pending_ack: true, auto_catchup_threshold: 25 },
      recovery: { max_age_hours: 24 },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const deps = { config, echoes: new EchoCache(), contacts: undefined, state } as any;
    return { deps, written };
  }

  /** A turn runner whose turns stay open until released, recording each call. */
  function heldTurns() {
    const calls: { key: SessionKey; rows: number[]; opts?: TurnOpts }[] = [];
    const releases: (() => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const handle = async (key: SessionKey, batch: InboundMessage[], opts?: TurnOpts) => {
      calls.push({ key, rows: batch.map((m) => m.rowId), opts });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => releases.push(r));
      inFlight--;
    };
    const releaseAll = async () => {
      // Released turns start the next queued chat, so keep draining.
      for (let i = 0; i < 20; i++) {
        await Bun.sleep(1);
        for (const r of releases.splice(0)) r();
      }
    };
    return { calls, handle, releaseAll, maxInFlight: () => maxInFlight };
  }

  test("the cursor comes back while the catch-up turns are still running", async () => {
    const { deps } = catchUpDeps();
    const turns = heldTurns();
    const backlog = [dm(A, "one"), dm(B, "two")];
    const catchUp = await Promise.race([
      runCatchUp({
        deps,
        locks: new SessionLocks(),
        startCursor: 0,
        concurrency: 3,
        handle: turns.handle,
        read: () => ({ messages: backlog, maxRowId: 77 }),
      }),
      Bun.sleep(500).then(() => null),
    ]);
    expect(catchUp).not.toBeNull();
    expect(catchUp!.cursor).toBe(77);
    let drained = false;
    void catchUp!.drained.then(() => {
      drained = true;
    });
    await Bun.sleep(5);
    expect(turns.calls).toHaveLength(2);
    expect(drained).toBe(false);
    await turns.releaseAll();
    await catchUp!.drained;
    expect(drained).toBe(true);
  });

  test("a live message for a chat still waiting joins that chat's catch-up turn", async () => {
    const { deps } = catchUpDeps();
    const turns = heldTurns();
    const a = dm(A, "a backlog");
    const b = dm(B, "b backlog");
    const catchUp = await runCatchUp({
      deps,
      locks: new SessionLocks(),
      startCursor: 0,
      concurrency: 1,
      handle: turns.handle,
      read: () => ({ messages: [a, b], maxRowId: b.rowId }),
    });
    await Bun.sleep(5);
    // A's turn is running; B is waiting for the one slot.
    expect(turns.calls.map((c) => c.key)).toEqual([keyA]);
    const liveB = dm(B, "b live");
    const liveA = dm(A, "a live");
    expect(catchUp.absorb(keyB, liveB)).toBe(true);
    // A's turn already started: its live message goes the usual way.
    expect(catchUp.absorb(keyA, liveA)).toBe(false);
    expect(catchUp.absorb("imessage:dm:+15550009999" as SessionKey, dm(A, "x"))).toBe(false);
    await turns.releaseAll();
    await catchUp.drained;
    expect(turns.calls[1]).toMatchObject({ key: keyB, rows: [b.rowId, liveB.rowId] });
    // Once B's turn has run, nothing is absorbed any more.
    expect(catchUp.absorb(keyB, dm(B, "later"))).toBe(false);
  });

  test("a chat's orphans and backlog run as one turn, oldest first, framed as a catch-up", async () => {
    const entry = (rowId: number) =>
      JSON.stringify({
        rowId,
        chatGuid: `iMessage;-;${A}`,
        chatIdentifier: A,
        fromHandle: A,
        text: "o",
      });
    const { deps } = catchUpDeps([
      { rowId: 5, sessionKey: keyA, entryJson: entry(5) },
      { rowId: 3, sessionKey: keyA, entryJson: entry(3) },
    ]);
    const turns = heldTurns();
    const backlog = dm(A, "new", { rowId: 12 });
    const catchUp = await runCatchUp({
      deps,
      locks: new SessionLocks(),
      startCursor: 10,
      concurrency: 3,
      handle: turns.handle,
      read: () => ({ messages: [backlog], maxRowId: 12 }),
    });
    await turns.releaseAll();
    await catchUp.drained;
    expect(turns.calls).toHaveLength(1);
    expect(turns.calls[0]!.rows).toEqual([3, 5, 12]);
    expect(turns.calls[0]!.opts?.catchUp?.count).toBe(3);
  });

  test("backlog rows get durable acks before the cursor moves past them", async () => {
    const { deps, written } = catchUpDeps();
    const turns = heldTurns();
    const backlog = [dm(A, "one"), dm(A, "two"), dm(B, "three")];
    const catchUp = await runCatchUp({
      deps,
      locks: new SessionLocks(),
      startCursor: 0,
      concurrency: 3,
      handle: turns.handle,
      read: () => ({ messages: backlog, maxRowId: backlog[2]!.rowId }),
    });
    expect(written.sort((x, y) => x - y)).toEqual(backlog.map((m) => m.rowId));
    await turns.releaseAll();
    await catchUp.drained;
  });

  test("no more than `concurrency` chats catch up at once", async () => {
    const { deps } = catchUpDeps();
    const turns = heldTurns();
    const backlog = ["+15550002011", "+15550002012", "+15550002013", "+15550002014"].map((h) =>
      dm(h, "hi"),
    );
    const catchUp = await runCatchUp({
      deps,
      locks: new SessionLocks(),
      startCursor: 0,
      concurrency: 2,
      handle: turns.handle,
      read: () => ({ messages: backlog, maxRowId: 99 }),
    });
    await turns.releaseAll();
    await catchUp.drained;
    expect(turns.calls).toHaveLength(4);
    expect(turns.maxInFlight()).toBe(2);
  });

  test("the daemon starts the watcher without waiting for the turns", () => {
    const main = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
    expect(main).not.toMatch(/await catchUp\.drained/);
    expect(main).toContain("void catchUp.drained.then(startRecovery)");
    // Absorb before the pipeline, after the durable ack.
    const route = main.slice(main.indexOf("const routeAccepted"));
    const ack = route.indexOf("state.writeInboundAck(");
    const absorb = route.indexOf("catchUp?.absorb(key, msg)");
    const enqueue = route.indexOf("pipeline.enqueue(key, msg)");
    expect(ack).toBeGreaterThan(0);
    expect(absorb).toBeGreaterThan(ack);
    expect(enqueue).toBeGreaterThan(absorb);
  });
});
