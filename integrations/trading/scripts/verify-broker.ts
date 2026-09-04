#!/usr/bin/env bun
import { resolve } from "node:path";
import { loadConfig } from "../../../src/config/config.ts";
/**
 * Step-0 broker connectivity probe. READ-ONLY — never places an order.
 *
 * Verifies whether code-level (headless) access to the hosted Robinhood MCP
 * works with the configured auth. This decides the execution mode:
 *   - probe OK  → the code-level HttpBroker can power the daemon price-quote
 *                 fetch, the dashboard's live data, and (optionally) code-side
 *                 order placement.
 *   - probe bad → fall back to in-session directive mode: the trading-session
 *                 model holds the Robinhood tools (Claude Code OAuth) and
 *                 places orders; code still risk-gates + journals.
 *
 * Run: `bun run scripts/verify-broker.ts`  (or `bun run trading:verify`)
 */
import { tradingConfig } from "../config.ts";
import { getBroker } from "../src/broker.ts";
import { TradingStore } from "../src/store.ts";

async function main() {
  const config = loadConfig(process.env.EDMUND_CONFIG_PATH ?? "./config.toml");
  const dataDir = resolve(config.paths.data_dir);
  const store = new TradingStore(dataDir);

  console.log("== Robinhood broker connectivity probe (read-only) ==");
  console.log(`url:     ${tradingConfig(config).mcp_url || "(none)"}`);
  console.log(`broker:  ${tradingConfig(config).broker}`);
  console.log(
    `auth:    ${Object.keys(tradingConfig(config).mcp_headers ?? {}).length > 0 ? "headers present" : "none (in-session OAuth only)"}`,
  );
  console.log(`account: ${tradingConfig(config).account_number || "(not set)"}`);
  console.log("");

  let ok = false;
  let detail = "";
  let backend = "none";
  try {
    const res = await getBroker(config);
    backend = res.backend;
    if (res.broker) {
      const ping = await res.broker.ping();
      ok = ping.ok;
      detail = ping.detail;
      if (ok && tradingConfig(config).account_number) {
        try {
          const p = await res.broker.getPortfolio();
          detail += ` | portfolio: equity=$${p.equity} cash=$${p.cash}`;
        } catch (e) {
          detail += ` | portfolio read failed: ${String(e).slice(0, 120)}`;
        }
      }
      await res.broker.close();
    } else {
      detail =
        backend === "in_session"
          ? "no code-level auth — execution runs in IN-SESSION directive mode (the trading session model places orders; code risk-gates)"
          : "no broker configured (trading.mcp_url empty)";
    }
  } catch (err) {
    detail = `probe error: ${String(err).slice(0, 200)}`;
  }

  const verdict = ok
    ? "CODE-LEVEL OK"
    : backend === "in_session"
      ? "IN-SESSION MODE"
      : "UNAVAILABLE";
  console.log(`verdict: ${verdict}`);
  console.log(`backend: ${backend}`);
  console.log(`detail:  ${detail}`);

  store.audit(Date.now(), "verify", "broker_probe", JSON.stringify({ ok, backend, detail }));
  store.close();

  // Exit 0 if we have *some* viable path (code OR in-session), 1 if nothing.
  process.exit(ok || backend === "in_session" ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-broker failed:", err);
  process.exit(1);
});
