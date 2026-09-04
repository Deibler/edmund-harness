import type { Config } from "../../../src/config/config.ts";
import { tradingConfig } from "../config.ts";
import { HttpBroker } from "./brokers/http.ts";
import type {
  BrokerPortfolio,
  BrokerPosition,
  BrokerQuote,
  OrderRequest,
  OrderResult,
} from "./types.ts";

/**
 * One internal broker interface over the hosted Robinhood MCP
 * (https://agent.robinhood.com/mcp/trading, Streamable HTTP + OAuth).
 *
 * Two execution modes reconcile the OAuth reality:
 *
 *  - CODE-LEVEL (HttpBroker): the daemon/dashboard connect to the Robinhood
 *    MCP directly as an MCP client. Requires auth (a bearer token in
 *    `trading.mcp_headers`), since there's no interactive OAuth flow in a
 *    background process. When available this is the single, idempotent
 *    execution path and powers the daemon price-quote fetch + dashboard.
 *
 *  - IN-SESSION (directive): when no code-level auth is available, the
 *    trading-session MODEL holds the Robinhood tools (Claude Code did the
 *    OAuth). Code still risk-gates and journals every order; the model is the
 *    transport that calls `place_equity_order`. `getBroker` returns a null
 *    broker for this case and execute.ts switches to directive mode.
 */
export interface Broker {
  getQuote(symbol: string): Promise<BrokerQuote>;
  getQuotes(symbols: string[]): Promise<BrokerQuote[]>;
  getPositions(): Promise<BrokerPosition[]>;
  getPortfolio(): Promise<BrokerPortfolio>;
  placeOrder(req: OrderRequest & { clientOrderId: string; qty: number }): Promise<OrderResult>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  /** Read-only identity check for the verification probe. */
  ping(): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}

export type BrokerBackend = "http_code" | "in_session" | "none";

/**
 * Resolve the code-level broker. Returns a connected HttpBroker when the
 * config allows + auth is present; otherwise returns a null broker with the
 * backend that the execute path should use ("in_session" = directive mode).
 */
export async function getBroker(
  config: Config,
): Promise<{ backend: BrokerBackend; broker: Broker | null }> {
  const url = tradingConfig(config).mcp_url;
  const headers = tradingConfig(config).mcp_headers ?? {};
  const haveAuth = Object.keys(headers).length > 0;
  const mode = tradingConfig(config).broker;

  if (!url) return { backend: "none", broker: null };

  if (mode === "http_code" || (mode === "auto" && haveAuth)) {
    try {
      const broker = (await HttpBroker.connect(url, headers)).withAccount(
        tradingConfig(config).account_number,
      );
      return { backend: "http_code", broker };
    } catch (err) {
      // Auth/connection failed — fall back to in-session directive mode rather
      // than crash a trading turn. Surfaced to the caller via backend.
      void err;
      return { backend: "in_session", broker: null };
    }
  }
  // Default: the model drives the Robinhood MCP in-session; code risk-gates.
  return { backend: "in_session", broker: null };
}
