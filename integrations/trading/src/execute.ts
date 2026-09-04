import type { Config } from "../../../src/config/config.ts";
import { tradingConfig } from "../config.ts";
import type { Broker } from "./broker.ts";
import type { PolicyStore } from "./policy.ts";
import { riskCheck } from "./risk.ts";
import type { TradingStore } from "./store.ts";
import type {
  BrokerPortfolio,
  BrokerPosition,
  BrokerQuote,
  DailyState,
  OrderRequest,
  Policy,
  RiskVerdict,
} from "./types.ts";

/**
 * The ONE path that reaches the broker. Whether code places the order
 * (http_code backend) or the session model does (in_session directive mode),
 * every order goes through the same deterministic risk gate + journal here.
 *
 * Order of operations (shared):
 *   1. assemble daily state (kill switch, breaker, trade count, day P&L)
 *   2. obtain fresh market data (code fetches via broker, or model supplies it)
 *   3. riskCheck — reject / clamp / allow (the safety layer)
 *   4. journal the decision (always, even on reject/noop)
 *   5. on allow/clamp: write a `submitting` order row keyed by a UUID ref_id
 *      (idempotency) BEFORE placement
 *   6a. http_code: place via broker, reconcile status, finalize order row
 *   6b. in_session: return a directive telling the model to place with the
 *       exact clamped qty + ref_id, then call `confirm_order` to finalize
 */

export type MarketData = {
  portfolio: BrokerPortfolio;
  positions: BrokerPosition[];
  quote: BrokerQuote;
};

export type ExecuteCtx = {
  store: TradingStore;
  policyStore: PolicyStore;
  config: Config;
  nowMs: number;
  wakeSource: string;
  thesis: string;
  /** Code-level broker, or null for in-session directive mode. */
  broker: Broker | null;
  /** Required in in-session mode (model-fetched). Ignored if broker present. */
  market?: MarketData;
};

export type ExecuteResult =
  | { mode: "rejected"; verdict: RiskVerdict; decisionId: string }
  | {
      mode: "placed";
      verdict: RiskVerdict;
      decisionId: string;
      orderId: string;
      status: string;
      brokerOrderId: string | null;
    }
  | {
      mode: "directive";
      verdict: RiskVerdict;
      decisionId: string;
      orderId: string;
      // What the model must send to place_equity_order:
      place: {
        account_number: string;
        symbol: string;
        side: string;
        type: string;
        quantity: string;
        limit_price?: string;
        ref_id: string;
        time_in_force: string;
        market_hours: string;
      };
    };

/** YYYY-MM-DD in the configured market timezone — the breaker's day key. */
function dayKey(nowMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/** Start-of-day epoch ms in the configured tz (for counting today's trades). */
function startOfDayMs(nowMs: number, tz: string): number {
  const key = dayKey(nowMs, tz);
  // Parse the local-midnight in tz back to an epoch by probing the offset.
  const guess = new Date(`${key}T00:00:00`).getTime();
  return Number.isFinite(guess) ? guess : nowMs - 24 * 3600 * 1000;
}

function assembleDailyState(
  store: TradingStore,
  policy: Policy,
  config: Config,
  nowMs: number,
): DailyState {
  const tz = tradingConfig(config).timezone;
  const today = dayKey(nowMs, tz);
  const tradesToday = store.countOrdersSince(startOfDayMs(nowMs, tz));
  const snap = store.latestSnapshot();
  // Approximate realized P&L for the breaker with the broker's day P&L when
  // available (conservative: includes unrealized). 0 if unknown.
  const realizedPnLToday = snap?.dayPnL ?? 0;
  return {
    realizedPnLToday,
    tradesToday,
    killSwitch: store.getKillSwitch() || policy.killSwitch,
    dailyLossTripped: store.isDailyLossTripped(today),
  };
}

export async function executeOrder(req: OrderRequest, ctx: ExecuteCtx): Promise<ExecuteResult> {
  const policy = ctx.policyStore.read();
  const daily = assembleDailyState(ctx.store, policy, ctx.config, ctx.nowMs);

  // Obtain market data.
  let market: MarketData;
  if (ctx.broker) {
    const [portfolio, positions, quote] = await Promise.all([
      ctx.broker.getPortfolio(),
      ctx.broker.getPositions(),
      ctx.broker.getQuote(req.symbol),
    ]);
    market = { portfolio, positions, quote };
  } else if (ctx.market) {
    market = ctx.market;
  } else {
    const verdict: RiskVerdict = {
      decision: "reject",
      qty: 0,
      reasons: [
        "no market data: provide portfolio/positions/quote (in-session) or configure a code broker",
      ],
    };
    const decisionId = journal(ctx, policy, req, verdict, null);
    return { mode: "rejected", verdict, decisionId };
  }

  // Trip the breaker flag if today's loss has breached the limit (so future
  // turns short-circuit even before riskCheck).
  if (
    daily.realizedPnLToday <= -Math.abs(policy.limits.dailyLossLimitUSD) &&
    !daily.dailyLossTripped
  ) {
    ctx.store.tripDailyLoss(dayKey(ctx.nowMs, tradingConfig(ctx.config).timezone), ctx.nowMs);
    daily.dailyLossTripped = true;
  }

  const verdict = riskCheck(
    req,
    policy.limits,
    market.portfolio,
    market.positions,
    market.quote,
    daily,
  );

  if (verdict.decision === "reject") {
    const decisionId = journal(ctx, policy, req, verdict, null);
    return { mode: "rejected", verdict, decisionId };
  }

  // allow | clamp → place. UUID ref_id is the idempotency key (RH dedups on it).
  const clientOrderId = crypto.randomUUID();
  const decisionId = journal(ctx, policy, req, verdict, null);
  const { id: orderId, created } = ctx.store.beginOrder({
    clientOrderId,
    decisionId,
    req,
    qty: verdict.qty,
    policyVersion: policy.version,
    submittedAt: ctx.nowMs,
  });
  ctx.store.audit(
    ctx.nowMs,
    ctx.broker ? "loop" : "loop_directive",
    "order_submitting",
    `${req.side} ${verdict.qty} ${req.symbol} (#${orderId})`,
  );

  if (!created) {
    // Idempotency hit — already have this order; don't place again.
    const existing = ctx.store.getOrder(orderId);
    return {
      mode: "placed",
      verdict,
      decisionId,
      orderId,
      status: existing?.status ?? "submitting",
      brokerOrderId: existing?.brokerOrderId ?? null,
    };
  }

  if (ctx.broker) {
    try {
      const result = await ctx.broker.placeOrder({ ...req, clientOrderId, qty: verdict.qty });
      ctx.store.updateOrder(orderId, {
        status: result.status,
        brokerOrderId: result.brokerOrderId,
        filledQty: result.filledQty ?? null,
        avgFillPrice: result.avgFillPrice ?? null,
        filledAt: result.status === "filled" ? ctx.nowMs : null,
      });
      ctx.store.audit(
        ctx.nowMs,
        "loop",
        "order_placed",
        `${orderId} → ${result.status} (broker ${result.brokerOrderId ?? "?"})`,
      );
      return {
        mode: "placed",
        verdict,
        decisionId,
        orderId,
        status: result.status,
        brokerOrderId: result.brokerOrderId,
      };
    } catch (err) {
      // Leave the row 'submitting' for reconciliation; never auto-replace.
      ctx.store.updateOrder(orderId, { error: String(err).slice(0, 400) });
      ctx.store.audit(ctx.nowMs, "loop", "order_error", `${orderId}: ${String(err).slice(0, 200)}`);
      throw err;
    }
  }

  // In-session directive: hand the model the exact, risk-approved order to place.
  return {
    mode: "directive",
    verdict,
    decisionId,
    orderId,
    place: {
      account_number: tradingConfig(ctx.config).account_number,
      symbol: req.symbol.toUpperCase(),
      side: req.side,
      type: req.type,
      quantity: String(verdict.qty),
      ...(req.type === "limit" && req.limitPrice ? { limit_price: String(req.limitPrice) } : {}),
      ref_id: clientOrderId,
      time_in_force: "gfd",
      market_hours: "regular_hours",
    },
  };
}

function journal(
  ctx: ExecuteCtx,
  policy: Policy,
  req: OrderRequest,
  verdict: RiskVerdict,
  orderId: string | null,
): string {
  return ctx.store.recordDecision({
    createdAt: ctx.nowMs,
    wakeSource: ctx.wakeSource,
    policyVersion: policy.version,
    thesis: ctx.thesis,
    candidateJson: JSON.stringify(req),
    verdict: verdict.decision,
    verdictReasons: JSON.stringify(verdict.reasons),
    orderId,
  });
}
