/**
 * Spend ledger (Phase-3 economics substrate): per-invocation rows + daily
 * rollups that every model call site records into. The observer's ghost
 * daily cap and the dashboard /api/metrics read from here.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger, localDay, resumedRunSpend } from "../src/spend/ledger.ts";

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

const opened: { l: SpendLedger; dir: string }[] = [];
/** A ledger in a temp dir, closed and removed after the file's tests. */
function ledger(): SpendLedger {
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  const l = new SpendLedger(dir);
  opened.push({ l, dir });
  return l;
}
afterAll(() => {
  for (const { l, dir } of opened) {
    l.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

/**
 * A resumed conversation reports the CLI's running total for the whole model
 * session, carried across restarts. Until 2026-09-24 that total was booked as
 * the turn's cost, and the ledger summed to 4-11x the real spend: one DM
 * logged $99.03 for a turn that cost $0.11.
 */
describe("turns that resume a conversation", () => {
  test("a turn costs the rise in its session's running total", () => {
    const l = ledger();
    const base = { sessionKey: "dm:+15550000001", subsystem: "turn", modelSessionId: "s1" };
    expect(l.record({ ...base, sessionTotalUsd: 0.4, resumedProcess: false })).toBeCloseTo(0.4);
    expect(l.record({ ...base, sessionTotalUsd: 0.55, resumedProcess: false })).toBeCloseTo(0.15);
    expect(l.record({ ...base, sessionTotalUsd: 0.62, resumedProcess: true })).toBeCloseTo(0.07);
    expect(l.daily(1)[0]!.costUsd).toBeCloseTo(0.62);
  });

  test("a resumed session with no earlier total here is unknown, not its whole history", () => {
    const l = ledger();
    const cost = l.record({
      sessionKey: "k",
      subsystem: "turn",
      modelSessionId: "old",
      sessionTotalUsd: 84.45,
      resumedProcess: true,
    });
    expect(cost).toBeNull();
    expect(l.daily(1)[0]!.costUsd).toBe(0);
    expect(l.daily(1)[0]!.turns).toBe(1);
  });

  test("a total that went down after a killed process is unknown, and the next turn counts from it", () => {
    const l = ledger();
    const base = { sessionKey: "k", subsystem: "turn", modelSessionId: "s2", resumedProcess: true };
    l.record({ ...base, sessionTotalUsd: 5, resumedProcess: false });
    expect(l.record({ ...base, sessionTotalUsd: 4.2 })).toBeNull();
    expect(l.record({ ...base, sessionTotalUsd: 4.5 })).toBeCloseTo(0.3);
  });

  test("sessions are kept apart by model session, not by chat", () => {
    const l = ledger();
    l.record({
      sessionKey: "k",
      subsystem: "turn",
      modelSessionId: "a",
      sessionTotalUsd: 10,
      resumedProcess: false,
    });
    expect(
      l.record({
        sessionKey: "k",
        subsystem: "turn",
        modelSessionId: "b",
        sessionTotalUsd: 0.3,
        resumedProcess: false,
      }),
    ).toBeCloseTo(0.3);
  });

  test("a one-shot call's own cost is recorded as given", () => {
    const l = ledger();
    expect(l.record({ sessionKey: "k", subsystem: "maintainer", costUsd: 0.02 })).toBeCloseTo(0.02);
  });

  test("resumedRunSpend hands over the total, never a cost", () => {
    const spend = resumedRunSpend({
      ok: true,
      totalCostUsd: 99.03,
      claudeSessionId: "s",
      resumedProcess: true,
    });
    expect(spend).toEqual({ sessionTotalUsd: 99.03, modelSessionId: "s", resumedProcess: true });
    expect("costUsd" in spend).toBe(false);
    expect(resumedRunSpend({ ok: false })).toEqual({ sessionTotalUsd: null });
  });

  test("no caller books a running total as a cost", () => {
    const src = join(import.meta.dir, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          p.endsWith(".ts") &&
          /costUsd:\s*[^,\n]*totalCostUsd/.test(readFileSync(p, "utf8"))
        )
          offenders.push(p);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
    for (const f of ["channels/turn.ts", "cron/fire.ts", "proactive/fire.ts"]) {
      expect(readFileSync(join(src, f), "utf8")).toContain("...resumedRunSpend(result)");
    }
  });

  test("an existing ledger gains the new columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-old-"));
    const old = new Database(join(dir, "spend.db"));
    old.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_key TEXT NOT NULL,
      subsystem TEXT NOT NULL, model TEXT, dur_ms INTEGER, ctx_tokens INTEGER, cost_usd REAL, tools INTEGER)`);
    old.close();
    const l = new SpendLedger(dir);
    expect(
      l.record({
        sessionKey: "k",
        subsystem: "turn",
        modelSessionId: "s",
        sessionTotalUsd: 1,
        resumedProcess: false,
      }),
    ).toBe(1);
    l.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
