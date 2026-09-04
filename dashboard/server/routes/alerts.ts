import { Hono } from "hono";
import type { AlertStore } from "../../../src/alerts/store.ts";
import type { AlertDto, AlertMuteDto } from "../types.ts";

export function alertsRoutes(deps: { alerts: AlertStore }): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const limit = Math.min(500, Number(c.req.query("limit") ?? 200));
    const rows = deps.alerts.listRecent(limit);
    const alerts: AlertDto[] = rows.map((r) => ({
      id: r.id,
      category: r.category,
      signature: r.signature,
      text: r.text,
      context: r.context,
      firedAtMs: r.firedAtMs,
      delivered: r.delivered,
    }));
    const mutes: AlertMuteDto[] = deps.alerts
      .listMutes()
      .map((m) => ({ category: m.category, untilMs: m.untilMs }));
    return c.json({ alerts, mutes });
  });

  app.post("/mute", async (c) => {
    const body = (await c.req.json()) as { category: string; minutes: number };
    if (!body.category || !body.minutes) {
      return c.json({ error: "category and minutes required" }, 400);
    }
    const untilMs = Date.now() + body.minutes * 60_000;
    deps.alerts.setMute(body.category, untilMs);
    return c.json({ muted: true, untilMs });
  });

  app.post("/unmute", async (c) => {
    const body = (await c.req.json()) as { category: string };
    if (!body.category) return c.json({ error: "category required" }, 400);
    deps.alerts.clearMute(body.category);
    return c.json({ unmuted: true });
  });

  return app;
}
