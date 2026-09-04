#!/usr/bin/env bun
import { resolve } from "node:path";
import { Hono } from "hono";
import {
  buildCookie,
  clearCookie,
  loadOrCreateSecret,
  readCookie,
  signSession,
  verifyPin,
  verifySession,
} from "../../../dashboard/server/auth.ts";
import { authMiddleware } from "../../../dashboard/server/middleware/auth.ts";
import { errorHandler } from "../../../dashboard/server/middleware/error.ts";
import { loadConfig } from "../../../src/config/config.ts";
/**
 * Trading dashboard — a dedicated local website for the Robinhood bot, on its
 * own port (tradingConfig(config).dashboard_port, default 4848). Separate from the
 * main edmund dashboard so trading controls live behind their own surface.
 *
 * PIN-gated by the SAME mechanism as the main dashboard (reuses auth.ts +
 * authMiddleware), so `bun run dashboard:set-pin <pin>` covers both. Opens the
 * trading SQLite stores read-mostly (WAL-safe alongside the daemon) and a
 * read-only broker for live portfolio data when code-level auth is configured.
 *
 * The UI is a single self-contained page (server-sent HTML + vanilla fetch) so
 * it runs with no build step. Pages: Portfolio, Positions, Orders, Policy
 * (view + edit), Triggers, Journal, and a prominent KILL SWITCH.
 */
import { tradingConfig } from "../config.ts";
import { getBroker } from "../src/broker.ts";
import { PolicyStore } from "../src/policy.ts";
import { TradingStore } from "../src/store.ts";
import { TriggerStore } from "../src/trigger-store.ts";
import { PAGE_HTML } from "./page.ts";

async function main() {
  const config = loadConfig(process.env.EDMUND_CONFIG_PATH ?? "./config.toml");
  const dataDir = resolve(config.paths.data_dir);
  const port = tradingConfig(config).dashboard_port;
  const bind = config.dashboard.bind;

  const secret = loadOrCreateSecret(dataDir);
  const store = new TradingStore(dataDir);
  const triggers = new TriggerStore(dataDir);
  const policyStore = new PolicyStore(resolve(dataDir, "trading"));

  // Read-only broker for live data, if code-level auth is configured.
  const { broker } = await getBroker(config).catch(() => ({ broker: null }));

  const app = new Hono();
  app.onError(errorHandler);

  // ---- auth (same cookie/PIN as the main dashboard) ----
  app.get("/api/auth/status", (c) => {
    const raw = readCookie(c.req.header("cookie") ?? null);
    return c.json({
      authenticated: Boolean(raw && verifySession(raw, secret)),
      pinConfigured: Boolean(config.dashboard.pin_hash),
    });
  });
  app.post("/api/auth/login", async (c) => {
    if (!config.dashboard.pin_hash) return c.json({ error: "PIN not configured" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { pin?: string };
    if (!body?.pin) return c.json({ error: "pin required" }, 400);
    if (!(await verifyPin(body.pin, config.dashboard.pin_hash))) {
      return c.json({ error: "incorrect pin" }, 401);
    }
    const exp = Date.now() + config.dashboard.session_days * 86_400_000;
    c.header(
      "Set-Cookie",
      buildCookie(signSession({ v: 1, sub: "user", exp }, secret), config.dashboard.session_days),
    );
    return c.json({ ok: true });
  });
  app.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", clearCookie());
    return c.json({ ok: true });
  });

  // ---- authed API ----
  const api = new Hono();
  api.use("*", authMiddleware({ secret }));

  api.get("/portfolio", async (c) => {
    let live: unknown = null;
    if (broker) {
      try {
        const [p, pos] = await Promise.all([broker.getPortfolio(), broker.getPositions()]);
        live = { portfolio: p, positions: pos };
      } catch (e) {
        live = { error: String(e).slice(0, 200) };
      }
    }
    return c.json({
      account: tradingConfig(config).account_number || null,
      live,
      cachedSnapshot: store.latestSnapshot(),
      killSwitch: store.getKillSwitch(),
    });
  });

  api.get("/orders", (c) => c.json({ orders: store.listOrders({ limit: 200 }) }));
  api.get("/journal", (c) =>
    c.json({ decisions: store.listDecisions(200), orders: store.listOrders({ limit: 50 }) }),
  );
  api.get("/audit", (c) => c.json({ audit: store.listAudit(200) }));
  api.get("/policy", (c) => c.json(policyStore.read()));

  api.put("/policy", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      vision?: string;
      limits?: Record<string, unknown>;
    };
    const p = policyStore.write({ vision: body.vision, limits: body.limits ?? {} }, Date.now());
    store.recordPolicyVersion(p.version, p.updatedAt, "dashboard", JSON.stringify(p), "");
    store.audit(Date.now(), "jordan_dashboard", "policy_update", `v${p.version}`);
    return c.json(p);
  });

  api.get("/triggers", (c) => {
    const armed = triggers.listArmed();
    return c.json({ armed });
  });

  api.get("/killswitch", (c) => c.json({ on: store.getKillSwitch() }));
  api.post("/killswitch", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { on?: boolean };
    const on = Boolean(body.on);
    store.setKillSwitch(on, Date.now(), "jordan_dashboard");
    policyStore.write({ killSwitch: on }, Date.now());
    return c.json({ on });
  });

  app.route("/api", api);

  // ---- single-page UI ----
  app.get("*", (c) => c.html(PAGE_HTML));

  Bun.serve({ hostname: bind, port, fetch: app.fetch });
  console.log(
    `[trading-dashboard] http://${bind}:${port} (broker live data: ${broker ? "on" : "off"})`,
  );
}

main().catch((err) => {
  console.error("trading-dashboard failed:", err);
  process.exit(1);
});
