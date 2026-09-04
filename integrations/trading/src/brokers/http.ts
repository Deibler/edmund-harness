import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Broker } from "../broker.ts";
import type {
  BrokerPortfolio,
  BrokerPosition,
  BrokerQuote,
  OrderRequest,
  OrderResult,
} from "../types.ts";

/**
 * Code-level MCP client to the hosted Robinhood MCP
 * (https://agent.robinhood.com/mcp/trading, Streamable HTTP). Tool names and
 * params mirror the connector schema:
 *   - get_equity_quotes({ symbols })
 *   - get_portfolio({ account_number })
 *   - get_equity_positions({ account_number })
 *   - place_equity_order({ account_number, symbol, side, type, quantity?,
 *       dollar_amount?, limit_price?, ref_id?, time_in_force?, market_hours? })
 *   - cancel_equity_order({ ... })
 *
 * Auth: headers passed at connect time (e.g. a bearer token). Without a valid
 * token a background process can't complete the interactive OAuth flow, so
 * getBroker() falls back to in-session directive mode (see broker.ts).
 *
 * Response bodies are parsed defensively — these are external shapes that may
 * drift; we extract the fields we need and tolerate the rest.
 */
export class HttpBroker implements Broker {
  private constructor(
    private client: Client,
    private accountNumber: string,
  ) {}

  static async connect(
    url: string,
    headers: Record<string, string>,
    accountNumber = "",
  ): Promise<HttpBroker> {
    const client = new Client({ name: "edmund-trading", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
    await client.connect(transport);
    return new HttpBroker(client, accountNumber);
  }

  /** Set/override the account number after construction (from config). */
  withAccount(accountNumber: string): this {
    this.accountNumber = accountNumber;
    return this;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = (await this.client.callTool({ name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (res.isError) {
      const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
      throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    }
    const text = (res.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async getQuotes(symbols: string[]): Promise<BrokerQuote[]> {
    const data = await this.call("get_equity_quotes", { symbols });
    const rows = extractArray(data, ["quotes", "results", "data"]);
    return rows.map((r) => parseQuote(r));
  }

  async getQuote(symbol: string): Promise<BrokerQuote> {
    const [q] = await this.getQuotes([symbol]);
    if (!q) throw new Error(`no quote for ${symbol}`);
    return q;
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const data = await this.call("get_equity_positions", { account_number: this.accountNumber });
    const rows = extractArray(data, ["positions", "results", "data"]);
    return rows.map((r) => parsePosition(r)).filter((p) => p.quantity > 0);
  }

  async getPortfolio(): Promise<BrokerPortfolio> {
    const data = await this.call("get_portfolio", { account_number: this.accountNumber });
    return parsePortfolio(data);
  }

  async placeOrder(
    req: OrderRequest & { clientOrderId: string; qty: number },
  ): Promise<OrderResult> {
    const args: Record<string, unknown> = {
      account_number: this.accountNumber,
      symbol: req.symbol.toUpperCase(),
      side: req.side,
      type: req.type,
      quantity: String(req.qty),
      ref_id: req.clientOrderId, // idempotency key — re-sent on retry
      time_in_force: "gfd",
      market_hours: "regular_hours",
    };
    if (req.type === "limit" && req.limitPrice) args.limit_price = String(req.limitPrice);
    const data = await this.call("place_equity_order", args);
    return parseOrderResult(data, req.clientOrderId);
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.call("cancel_equity_order", { order_id: brokerOrderId });
  }

  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      const data = await this.call("get_accounts", {});
      const rows = extractArray(data, ["accounts", "results", "data"]);
      return { ok: true, detail: `get_accounts ok (${rows.length} account(s))` };
    } catch (err) {
      return { ok: false, detail: String(err).slice(0, 200) };
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      /* ignore */
    }
  }
}

// ---- defensive parsers ---------------------------------------------------

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function extractArray(data: unknown, keys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.map(asObj);
  const o = asObj(data);
  for (const k of keys) {
    if (Array.isArray(o[k])) return (o[k] as unknown[]).map(asObj);
  }
  return [];
}

function parseQuote(r: Record<string, unknown>): BrokerQuote {
  const last = num(r.last_trade_price ?? r.last ?? r.price ?? r.mark_price ?? r.ask_price);
  const tradable = r.tradable === undefined ? last > 0 : Boolean(r.tradable ?? r.has_traded);
  return {
    symbol: String(r.symbol ?? r.ticker ?? "").toUpperCase(),
    last,
    tradable,
    bid: r.bid_price !== undefined ? num(r.bid_price) : undefined,
    ask: r.ask_price !== undefined ? num(r.ask_price) : undefined,
  };
}

function parsePosition(r: Record<string, unknown>): BrokerPosition {
  const quantity = num(r.quantity ?? r.shares);
  const avgCost = num(r.average_buy_price ?? r.avg_cost ?? r.average_cost);
  const marketValue =
    r.market_value !== undefined ? num(r.market_value) : quantity * num(r.price ?? r.last_price);
  return {
    symbol: String(r.symbol ?? r.ticker ?? "").toUpperCase(),
    quantity,
    avgCost,
    marketValue: marketValue || quantity * avgCost,
  };
}

function parsePortfolio(data: unknown): BrokerPortfolio {
  const o = asObj(data);
  const equity = num(
    o.equity ?? o.total_market_value ?? o.market_value ?? o.portfolio_value ?? o.total_equity,
  );
  const cash = num(o.cash ?? o.uninvested_cash ?? o.cash_available_for_withdrawal);
  const buyingPower = num(o.buying_power ?? o.buying_power_amount ?? cash);
  return {
    equity: equity || cash,
    cash,
    buyingPower,
    dayPnL: o.day_pnl !== undefined ? num(o.day_pnl) : undefined,
  };
}

function parseOrderResult(data: unknown, clientOrderId: string): OrderResult {
  const o = asObj(data);
  const brokerOrderId = (o.id ?? o.order_id ?? o.ref_id) as string | undefined;
  const state = String(o.state ?? o.status ?? "submitted").toLowerCase();
  const status =
    state.includes("fill") && !state.includes("partial")
      ? "filled"
      : state.includes("partial")
        ? "partial"
        : state.includes("cancel")
          ? "canceled"
          : state.includes("reject")
            ? "rejected"
            : "submitted";
  return {
    id: "",
    clientOrderId,
    brokerOrderId: brokerOrderId ?? null,
    status,
    filledQty: o.cumulative_quantity !== undefined ? num(o.cumulative_quantity) : undefined,
    avgFillPrice: o.average_price !== undefined ? num(o.average_price) : undefined,
  };
}
