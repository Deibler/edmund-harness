import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/sessions/store.ts";

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-state-"));
  store = new StateStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function put(key: string, lastInboundMs: number, lastOutboundMs: number): void {
  store.upsertSession({
    sessionKey: key,
    claudeSessionId: null,
    chatGuid: `guid-${key}`,
    isGroup: 0,
    lastInboundMs,
    lastOutboundMs,
  });
}

describe("StateStore", () => {
  test("cursor round-trips with fallback", () => {
    expect(store.getCursor("c", 42)).toBe(42);
    store.setCursor("c", 99);
    expect(store.getCursor("c", 42)).toBe(99);
  });

  test("upsert + getSession", () => {
    put("a", 100, 50);
    const s = store.getSession("a");
    expect(s?.lastInboundMs).toBe(100);
    expect(s?.lastOutboundMs).toBe(50);
    expect(s?.sessionBackend).toBeNull();
    expect(store.getSession("missing")).toBeNull();
  });

  test("provider and opaque thread id round-trip atomically", () => {
    put("provider", 100, 50);
    store.setModelSession("provider", "codex-thread", "codex");
    expect(store.getSession("provider")).toMatchObject({
      claudeSessionId: "codex-thread",
      sessionBackend: "codex",
    });

    store.setModelSession("provider", null, "claude");
    expect(store.getSession("provider")).toMatchObject({
      claudeSessionId: null,
      sessionBackend: "claude",
    });
  });

  test("listSessionsNeedingRecovery returns only stuck sessions older than the cutoff", () => {
    put("owes-old", 1_000, 500); // inbound > outbound, old  -> candidate
    put("owes-recent", 9_000, 500); // inbound > outbound, recent -> excluded by cutoff
    put("answered", 1_000, 2_000); // outbound >= inbound -> not stuck
    put("never-talked", 0, 0); // no inbound -> not stuck

    const stuck = store.listSessionsNeedingRecovery(5_000).map((s) => s.sessionKey);
    expect(stuck).toEqual(["owes-old"]);

    // Widen the cutoff and the recent one shows up too (DESC order).
    const both = store.listSessionsNeedingRecovery(10_000).map((s) => s.sessionKey);
    expect(both).toEqual(["owes-recent", "owes-old"]);
  });

  test("error bookkeeping increments and clears", () => {
    put("e", 100, 50);
    store.recordError("e", "request_too_large", 123);
    let s = store.getSession("e")!;
    expect(s.lastErrorClass).toBe("request_too_large");
    expect(s.healAttemptsCount).toBe(1);
    store.recordError("e", "request_too_large", 200);
    expect(store.getSession("e")!.healAttemptsCount).toBe(2);
    store.clearError("e");
    s = store.getSession("e")!;
    expect(s.lastErrorClass).toBeNull();
    expect(s.healAttemptsCount).toBe(0);
  });

  test("replayed-inbound mark/check/prune", () => {
    expect(store.wasReplayed("s", 1)).toBe(false);
    store.markReplayed("s", 1, 100);
    store.markReplayed("s", 2, 200);
    store.markReplayed("s", 3, 300);
    expect(store.wasReplayed("s", 2)).toBe(true);
    store.pruneReplayed("s", 1); // keep only the newest
    expect(store.wasReplayed("s", 3)).toBe(true);
    expect(store.wasReplayed("s", 1)).toBe(false);
    expect(store.wasReplayed("s", 2)).toBe(false);
  });

  test("deleteSession removes the row and its replayed entries", () => {
    put("d", 100, 50);
    store.markReplayed("d", 7, 100);
    store.deleteSession("d");
    expect(store.getSession("d")).toBeNull();
    expect(store.wasReplayed("d", 7)).toBe(false);
  });

  test("inbound_ack: write / list / clear / delete round-trip", () => {
    store.writeInboundAck(101, "s1", '{"rowId":101}');
    store.writeInboundAck(102, "s1", '{"rowId":102}');
    store.writeInboundAck(103, "s2", '{"rowId":103}');
    // idempotent re-write (same rowId, same session)
    store.writeInboundAck(101, "s1", '{"rowId":101,"v":2}');

    const all = store.listInboundAcks();
    expect(all.length).toBe(3);
    const s1acks = all.filter((a) => a.sessionKey === "s1");
    expect(s1acks.length).toBe(2);
    // re-write should have updated the json
    expect(s1acks.find((a) => a.rowId === 101)!.entryJson).toContain('"v":2');
    // oldest first
    expect(all[0]!.rowId).toBeLessThan(all[2]!.rowId);

    // clear s1 up to 101 (should only delete 101, not 102)
    store.clearInboundAcks("s1", 101);
    const after = store.listInboundAcks();
    expect(after.length).toBe(2); // 102 (s1) + 103 (s2)
    expect(after.some((a) => a.rowId === 101)).toBe(false);
    expect(after.some((a) => a.rowId === 102)).toBe(true);

    // delete single
    store.deleteInboundAck(102);
    expect(store.listInboundAcks().length).toBe(1); // only 103 remains
  });

  test("inbound_ack: empty list returns []", () => {
    expect(store.listInboundAcks()).toEqual([]);
  });

  test("inbound_ack: clear with max above all rows clears everything for that session", () => {
    store.writeInboundAck(1, "s", "{}");
    store.writeInboundAck(2, "s", "{}");
    store.writeInboundAck(3, "other", "{}");
    store.clearInboundAcks("s", 999);
    const all = store.listInboundAcks();
    expect(all.length).toBe(1);
    expect(all[0]!.sessionKey).toBe("other");
  });
});
