/**
 * Shared types for the autonomous trading subsystem. Single source of truth
 * imported by the broker, the risk engine, the store, the MCP tools, and the
 * dashboard so an order spec means the same thing everywhere.
 */

type OrderSide = "buy" | "sell";
type OrderType = "market" | "limit";

/** Hard, code-enforced limits. The model never sets these directly — Jordan
 *  does, by chatting, via `update_policy`. The risk engine enforces them. */
export type PolicyLimits = {
  /** PRIMARY limit: max fraction (0..1) of total account equity in any single
   *  position. e.g. 0.30 = no position may exceed 30% of equity. */
  maxPctPerName: number;
  /** Absolute backstop on a single position's dollar value. */
  maxPositionUSD: number;
  /** Halt new orders for the day once realized losses exceed this (USD, > 0). */
  dailyLossLimitUSD: number;
  /** Max orders placed in a single trading day. */
  maxTradesPerDay: number;
  /** Never let cash fall below this after a buy (USD). */
  cashFloorUSD: number;
  /** Allow short / sell-to-open. Default false (long-only). */
  allowShort: boolean;
  /** Allow fractional-share quantities. Needed for a small account. */
  allowFractional: boolean;
  /** If non-empty, ONLY these symbols may be traded. */
  allowedSymbols: string[];
  /** These symbols may never be traded (takes precedence over allowed). */
  forbiddenSymbols: string[];
};

export type Policy = {
  version: number;
  updatedAt: number;
  /** Free-text guidance in Jordan's words — the "why" behind the limits. */
  vision: string;
  limits: PolicyLimits;
  /** Soft mirror of the runtime kill switch for convenience; the runtime
   *  flag in trading.db is authoritative. */
  killSwitch: boolean;
};

export type BrokerQuote = {
  symbol: string;
  /** Last/most-recent trade price. */
  last: number;
  /** Whether the instrument is currently tradable (market open + not halted). */
  tradable: boolean;
  /** Optional bid/ask if the broker provides them. */
  bid?: number;
  ask?: number;
};

export type BrokerPosition = {
  symbol: string;
  quantity: number;
  avgCost: number;
  marketValue: number;
};

export type BrokerPortfolio = {
  /** Total account equity (cash + positions). */
  equity: number;
  cash: number;
  buyingPower: number;
  /** Intraday P&L if the broker reports it. */
  dayPnL?: number;
};

/** A requested order, as the model proposes it. Quantity OR notional. */
export type OrderRequest = {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  /** Share quantity (may be fractional). One of qty/notionalUSD required. */
  qty?: number;
  /** Dollar amount to buy/sell; resolved to qty at the quote price. */
  notionalUSD?: number;
  /** Required for limit orders. */
  limitPrice?: number;
};

type RiskDecision = "allow" | "clamp" | "reject";

export type RiskVerdict = {
  decision: RiskDecision;
  /** Final, possibly-clamped share quantity to send to the broker. 0 on reject. */
  qty: number;
  /** Human-readable reasons for the decision (each clamp/reject explained). */
  reasons: string[];
};

/** Per-day mutable state the risk engine reads (from the journal/flags). */
export type DailyState = {
  realizedPnLToday: number;
  tradesToday: number;
  killSwitch: boolean;
  dailyLossTripped: boolean;
};

export type OrderResult = {
  /** Our internal order id. */
  id: string;
  clientOrderId: string;
  brokerOrderId: string | null;
  status: OrderStatus;
  filledQty?: number;
  avgFillPrice?: number;
  error?: string;
};

export type OrderStatus =
  | "submitting"
  | "submitted"
  | "filled"
  | "partial"
  | "canceled"
  | "rejected"
  | "failed";
