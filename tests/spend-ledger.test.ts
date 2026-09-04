/**
 * Spend ledger (Phase-3 economics substrate): per-invocation rows + daily
 * rollups that every model call site records into. The observer's ghost
 * daily cap and the dashboard /api/metrics read from here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger, localDay } from "../src/spend/ledger.ts";

function withLedger(fn: (l: SpendLedger) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  const l = new SpendLedger(dir);
  try {
    fn(l);
  } finally {
    l.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const KEY = "imessage:dm:+15550100001";

describe("SpendLedger", () => {
  test("records roll up per (day, session, subsystem)", () => {
    withLedger((l) => {
      const now = Date.parse("2026-07-28T15:00:00");
      l.record({ sessionKey: KEY, subsystem: "turn", costUsd: 1.5, durMs: 10_000 }, now);
      l.record({ sessionKey: KEY, subsystem: "turn", costUsd: 0.5, durMs: 5_000 }, now + 60_000);
      l.record({ sessionKey: KEY, subsystem: "ghost", costUsd: 0.2, durMs: 30_000 }, now);
      const rows = l.daily(7, now);
      const turn = rows.find((r) => r.subsystem === "turn");
      expect(turn?.turns).toBe(2);
      expect(turn?.costUsd).toBeCloseTo(2.0);
      expect(turn?.durMs).toBe(15_000);
      const ghost = rows.find((r) => r.subsystem === "ghost");
      expect(ghost?.turns).toBe(1);
    });
  });

  test("countDay counts one subsystem for one session only", () => {
    withLedger((l) => {
      const now = Date.parse("2026-07-28T15:00:00");
      const day = localDay(now);
      for (let i = 0; i < 3; i++) {
        l.record({ sessionKey: KEY, subsystem: "ghost-prescreen" }, now + i);
      }
      l.record({ sessionKey: "imessage:dm:+15550999999", subsystem: "ghost-prescreen" }, now);
      l.record({ sessionKey: KEY, subsystem: "ghost" }, now);
      expect(l.countDay(day, KEY, "ghost-prescreen")).toBe(3);
      expect(l.countDay(day, KEY, "ghost")).toBe(1);
      expect(l.countDay(day, KEY, "turn")).toBe(0);
      // Next day starts fresh.
      expect(l.countDay(localDay(now + 24 * 3_600_000), KEY, "ghost-prescreen")).toBe(0);
    });
  });

  test("null costs count as invocations but add $0", () => {
    withLedger((l) => {
      const now = Date.parse("2026-07-28T15:00:00");
      l.record({ sessionKey: KEY, subsystem: "turn", costUsd: null, durMs: 8_000 }, now);
      const rows = l.daily(7, now);
      expect(rows[0]?.turns).toBe(1);
      expect(rows[0]?.costUsd).toBe(0);
    });
  });

  test("recent returns raw rows newest first", () => {
    withLedger((l) => {
      const now = Date.parse("2026-07-28T15:00:00");
      l.record({ sessionKey: KEY, subsystem: "turn", model: "m1" }, now);
      l.record({ sessionKey: KEY, subsystem: "agent", model: "m2" }, now + 1000);
      const recent = l.recent(10);
      expect(recent.length).toBe(2);
      expect(recent[0]?.subsystem).toBe("agent");
      expect(recent[1]?.model).toBe("m1");
    });
  });
});
