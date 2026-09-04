import { describe, expect, test } from "bun:test";
import { extractOrphanAcks, groupBacklog } from "../src/boot/catchup.ts";
import type { Deps } from "../src/channels/deps.ts";
import type { Config } from "../src/config/config.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { EchoCache } from "../src/sessions/echo-cache.ts";
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
