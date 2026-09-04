import { describe, expect, test } from "bun:test";
import { riskCheck } from "../../integrations/trading/src/risk.ts";
import type {
  BrokerPortfolio,
  BrokerPosition,
  BrokerQuote,
  DailyState,
  OrderRequest,
  PolicyLimits,
} from "../../integrations/trading/src/types.ts";

const LIMITS: PolicyLimits = {
  maxPctPerName: 0.3, // 30% of equity per name
  maxPositionUSD: 10_000,
  dailyLossLimitUSD: 500,
  maxTradesPerDay: 10,
  cashFloorUSD: 0,
  allowShort: false,
  allowFractional: true,
  allowedSymbols: [],
  forbiddenSymbols: [],
};

// $120 account, all cash — Jordan's real starting condition.
const PORT: BrokerPortfolio = { equity: 120, cash: 120, buyingPower: 120 };
const QUOTE = (over: Partial<BrokerQuote> = {}): BrokerQuote => ({
  symbol: "AAPL",
  last: 100,
  tradable: true,
  ...over,
});
const DAILY = (over: Partial<DailyState> = {}): DailyState => ({
  realizedPnLToday: 0,
  tradesToday: 0,
  killSwitch: false,
  dailyLossTripped: false,
  ...over,
});
const BUY = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  symbol: "AAPL",
  side: "buy",
  type: "market",
  ...over,
});

function run(
  req: OrderRequest,
  opts: {
    limits?: Partial<PolicyLimits>;
    port?: BrokerPortfolio;
    positions?: BrokerPosition[];
    quote?: BrokerQuote;
    daily?: DailyState;
  } = {},
) {
  return riskCheck(
    req,
    { ...LIMITS, ...opts.limits },
    opts.port ?? PORT,
    opts.positions ?? [],
    opts.quote ?? QUOTE(),
    opts.daily ?? DAILY(),
  );
}

describe("riskCheck — global halts", () => {
  test("kill switch rejects everything", () => {
    expect(run(BUY({ qty: 0.1 }), { daily: DAILY({ killSwitch: true }) }).decision).toBe("reject");
  });
  test("daily-loss breaker rejects", () => {
    expect(run(BUY({ qty: 0.1 }), { daily: DAILY({ dailyLossTripped: true }) }).decision).toBe(
      "reject",
    );
  });
  test("max trades/day rejects", () => {
    const v = run(BUY({ qty: 0.1 }), { daily: DAILY({ tradesToday: 10 }) });
    expect(v.decision).toBe("reject");
  });
  test("realized loss past limit rejects", () => {
    const v = run(BUY({ qty: 0.1 }), { daily: DAILY({ realizedPnLToday: -500 }) });
    expect(v.decision).toBe("reject");
  });
});

describe("riskCheck — symbol allow/deny", () => {
  test("forbidden symbol rejects", () => {
    expect(run(BUY({ qty: 0.1 }), { limits: { forbiddenSymbols: ["AAPL"] } }).decision).toBe(
      "reject",
    );
  });
  test("not on allowed list rejects", () => {
    expect(run(BUY({ qty: 0.1 }), { limits: { allowedSymbols: ["MSFT"] } }).decision).toBe(
      "reject",
    );
  });
  test("on allowed list is fine", () => {
    expect(run(BUY({ qty: 0.1 }), { limits: { allowedSymbols: ["AAPL"] } }).decision).toBe("allow");
  });
});

describe("riskCheck — tradability", () => {
  test("not tradable rejects", () => {
    expect(run(BUY({ qty: 0.1 }), { quote: QUOTE({ tradable: false }) }).decision).toBe("reject");
  });
});

describe("riskCheck — the core case: %-of-equity cap on a small account", () => {
  test("Jordan's case: $110 buy on a $120 account clamps to the 30% cap (~$36)", () => {
    // Ask to buy $110 of a $100 stock = 1.1 shares.
    const v = run(BUY({ notionalUSD: 110 }));
    expect(v.decision).toBe("clamp");
    // 30% of $120 = $36 → 0.36 shares at $100.
    expect(v.qty).toBeCloseTo(0.36, 6);
    expect(v.qty * 100).toBeLessThanOrEqual(36 + 1e-6);
  });

  test("a within-cap buy is allowed unchanged", () => {
    const v = run(BUY({ notionalUSD: 30 })); // $30 < $36 cap
    expect(v.decision).toBe("allow");
    expect(v.qty).toBeCloseTo(0.3, 6);
  });

  test("existing position reduces remaining room", () => {
    const positions: BrokerPosition[] = [
      { symbol: "AAPL", quantity: 0.2, avgCost: 100, marketValue: 20 },
    ];
    // Cap is $36; already hold $20; room = $16 → 0.16 shares.
    const v = run(BUY({ notionalUSD: 100 }), { positions });
    expect(v.decision).toBe("clamp");
    expect(v.qty).toBeCloseTo(0.16, 6);
  });

  test("already at cap rejects", () => {
    const positions: BrokerPosition[] = [
      { symbol: "AAPL", quantity: 0.4, avgCost: 100, marketValue: 40 },
    ];
    expect(run(BUY({ notionalUSD: 10 }), { positions }).decision).toBe("reject");
  });
});

describe("riskCheck — cash floor", () => {
  test("clamps to preserve the cash floor", () => {
    // Floor $100 on a $120 cash account → only $20 spendable.
    const v = run(BUY({ notionalUSD: 30 }), { limits: { cashFloorUSD: 100 } });
    expect(v.decision).toBe("clamp");
    expect(v.qty).toBeCloseTo(0.2, 6); // $20 / $100
  });
  test("at floor rejects", () => {
    expect(run(BUY({ notionalUSD: 30 }), { limits: { cashFloorUSD: 120 } }).decision).toBe(
      "reject",
    );
  });
});

describe("riskCheck — sells", () => {
  test("sell more than held clamps to held qty", () => {
    const positions: BrokerPosition[] = [
      { symbol: "AAPL", quantity: 0.5, avgCost: 100, marketValue: 50 },
    ];
    const v = run(BUY({ side: "sell", qty: 2 }), { positions });
    expect(v.decision).toBe("clamp");
    expect(v.qty).toBeCloseTo(0.5, 6);
  });
  test("sell with no position rejects (shorting off)", () => {
    expect(run(BUY({ side: "sell", qty: 1 })).decision).toBe("reject");
  });
});

describe("riskCheck — fractional rule", () => {
  test("whole-share-only rounds down and rejects sub-1-share buys", () => {
    // $36 cap on a $100 stock → 0.36 shares → floor = 0 → reject.
    const v = run(BUY({ notionalUSD: 100 }), { limits: { allowFractional: false } });
    expect(v.decision).toBe("reject");
  });
  test("whole-share-only allows when >= 1 share fits", () => {
    const port: BrokerPortfolio = { equity: 1000, cash: 1000, buyingPower: 1000 };
    // 30% of $1000 = $300 → 3 shares at $100.
    const v = run(BUY({ notionalUSD: 1000 }), { limits: { allowFractional: false }, port });
    expect(v.decision).toBe("clamp");
    expect(v.qty).toBe(3);
  });
});

describe("riskCheck — input validation", () => {
  test("no qty or notional rejects", () => {
    expect(run(BUY()).decision).toBe("reject");
  });
  test("limit order without limit price rejects", () => {
    expect(run(BUY({ type: "limit", qty: 0.1 })).decision).toBe("reject");
  });
});
