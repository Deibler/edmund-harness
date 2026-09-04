import { Hono } from "hono";
import type { SpendLedger } from "../../../src/spend/ledger.ts";

/**
 * Spend/latency metrics from data/spend.db (see src/spend/ledger.ts).
 *
 *   GET /api/metrics?days=14   → daily rollups + per-subsystem and
 *                                per-session totals for the window
 *   GET /api/metrics/recent    → latest raw invocations (drill-down)
 */
export function metricsRoutes(deps: { ledger: SpendLedger }): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 14) || 14));
    const rows = deps.ledger.daily(days);

    const byDay = new Map<string, { costUsd: number; turns: number; durMs: number }>();
    const bySubsystem = new Map<string, { costUsd: number; turns: number; durMs: number }>();
    const bySession = new Map<string, { costUsd: number; turns: number }>();
    for (const r of rows) {
      const d = byDay.get(r.day) ?? { costUsd: 0, turns: 0, durMs: 0 };
      d.costUsd += r.costUsd;
      d.turns += r.turns;
      d.durMs += r.durMs;
      byDay.set(r.day, d);
      const s = bySubsystem.get(r.subsystem) ?? { costUsd: 0, turns: 0, durMs: 0 };
      s.costUsd += r.costUsd;
      s.turns += r.turns;
      s.durMs += r.durMs;
      bySubsystem.set(r.subsystem, s);
      const k = bySession.get(r.sessionKey) ?? { costUsd: 0, turns: 0 };
      k.costUsd += r.costUsd;
      k.turns += r.turns;
      bySession.set(r.sessionKey, k);
    }

    return c.json({
      days,
      rows,
      byDay: [...byDay.entries()]
        .map(([day, v]) => ({ day, ...v }))
        .sort((a, b) => (a.day < b.day ? -1 : 1)),
      bySubsystem: [...bySubsystem.entries()]
        .map(([subsystem, v]) => ({ subsystem, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd),
      bySession: [...bySession.entries()]
        .map(([sessionKey, v]) => ({ sessionKey, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd)
        .slice(0, 25),
    });
  });

  app.get("/recent", (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    return c.json({ recent: deps.ledger.recent(limit) });
  });

  return app;
}
