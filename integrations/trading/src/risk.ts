import type {
  BrokerPortfolio,
  BrokerPosition,
  BrokerQuote,
  DailyState,
  OrderRequest,
  PolicyLimits,
  RiskVerdict,
} from "./types.ts";

/**
 * Deterministic pre-trade risk check — the safety layer that replaces human
 * approval for this fully-autonomous, real-money bot. PURE: no I/O, no model,
 * no clock. Same inputs → same verdict, so it's exhaustively unit-testable and
 * so the dashboard dry-run and the live execution path share one function.
 *
 * Returns:
 *   - allow  → send `qty` as requested
 *   - clamp  → send the reduced `qty` (still a valid, smaller order)
 *   - reject → do not trade; `qty` is 0
 *
 * The PRIMARY limit is `maxPctPerName`: a single position may never exceed a
 * configured fraction of total account equity. On a small account this is what
 * stops the bot from sinking everything into one name.
 */
export function riskCheck(
  req: OrderRequest,
  limits: PolicyLimits,
  portfolio: BrokerPortfolio,
  positions: BrokerPosition[],
  quote: BrokerQuote,
  daily: DailyState,
): RiskVerdict {
  const reasons: string[] = [];
  const reject = (reason: string): RiskVerdict => ({
    decision: "reject",
    qty: 0,
    reasons: [...reasons, reason],
  });

  const symbol = req.symbol.toUpperCase();

  // 1. Global halts.
  if (daily.killSwitch) return reject("kill switch is on — trading halted");
  if (daily.dailyLossTripped) return reject("daily-loss circuit breaker tripped for today");
  if (daily.tradesToday >= limits.maxTradesPerDay) {
    return reject(`max trades/day reached (${daily.tradesToday}/${limits.maxTradesPerDay})`);
  }
  if (daily.realizedPnLToday <= -Math.abs(limits.dailyLossLimitUSD)) {
    return reject(
      `daily loss limit hit (realized ${daily.realizedPnLToday.toFixed(2)} ≤ -${limits.dailyLossLimitUSD})`,
    );
  }

  // 2. Symbol allow/deny.
  if (limits.forbiddenSymbols.map((s) => s.toUpperCase()).includes(symbol)) {
    return reject(`${symbol} is on the forbidden list`);
  }
  if (
    limits.allowedSymbols.length > 0 &&
    !limits.allowedSymbols.map((s) => s.toUpperCase()).includes(symbol)
  ) {
    return reject(`${symbol} is not on the allowed list`);
  }

  // 3. Tradability + price sanity.
  if (!quote.tradable)
    return reject(`${symbol} is not currently tradable (market closed or halted)`);
  const price = req.type === "limit" ? (req.limitPrice ?? quote.last) : quote.last;
  if (!(price > 0)) return reject(`no valid price for ${symbol}`);
  if (req.type === "limit" && !(req.limitPrice && req.limitPrice > 0)) {
    return reject("limit order requires a positive limit price");
  }

  // 4. Resolve requested quantity (from qty or notional).
  let qty: number;
  if (typeof req.qty === "number" && req.qty > 0) {
    qty = req.qty;
  } else if (typeof req.notionalUSD === "number" && req.notionalUSD > 0) {
    qty = req.notionalUSD / price;
  } else {
    return reject("order must specify a positive qty or notionalUSD");
  }

  const held = positions.find((p) => p.symbol.toUpperCase() === symbol);

  // ---- SELL path: can't sell more than held (long-only unless allowShort). ----
  if (req.side === "sell") {
    const heldQty = held?.quantity ?? 0;
    if (heldQty <= 0 && !limits.allowShort) {
      return reject(`no ${symbol} position to sell (shorting disabled)`);
    }
    if (!limits.allowShort && qty > heldQty) {
      qty = clampQty(
        qty,
        heldQty,
        limits,
        reasons,
        `sell qty clamped to held ${heldQty} ${symbol}`,
      );
    }
    return finalize(qty, limits, reasons);
  }

  // ---- BUY path: enforce equity %, position cap, and cash floor. ----
  const equity = portfolio.equity;
  if (!(equity > 0)) return reject("account equity is zero/unknown — cannot size a buy");

  const existingValue = held?.marketValue ?? 0;

  // 4a. PRIMARY: max % of equity per name.
  const maxValueByPct = limits.maxPctPerName * equity;
  const allowedAddByPct = maxValueByPct - existingValue;
  if (allowedAddByPct <= 0) {
    return reject(
      `${symbol} already at/above ${(limits.maxPctPerName * 100).toFixed(0)}% of equity (have $${existingValue.toFixed(2)} of max $${maxValueByPct.toFixed(2)})`,
    );
  }
  if (qty * price > allowedAddByPct) {
    qty = clampQty(
      qty,
      allowedAddByPct / price,
      limits,
      reasons,
      `clamped to ${(limits.maxPctPerName * 100).toFixed(0)}% equity cap for ${symbol}`,
    );
  }

  // 4b. Absolute per-position dollar backstop.
  const allowedAddByAbs = limits.maxPositionUSD - existingValue;
  if (allowedAddByAbs <= 0) {
    return reject(`${symbol} already at/above max position $${limits.maxPositionUSD}`);
  }
  if (qty * price > allowedAddByAbs) {
    qty = clampQty(
      qty,
      allowedAddByAbs / price,
      limits,
      reasons,
      `clamped to max position $${limits.maxPositionUSD} for ${symbol}`,
    );
  }

  // 4c. Cash floor: spend may not push cash below the floor.
  const spendable = portfolio.cash - limits.cashFloorUSD;
  if (spendable <= 0) {
    return reject(
      `cash $${portfolio.cash.toFixed(2)} at/below floor $${limits.cashFloorUSD} — no buying room`,
    );
  }
  if (qty * price > spendable) {
    qty = clampQty(
      qty,
      spendable / price,
      limits,
      reasons,
      `clamped to keep $${limits.cashFloorUSD} cash floor`,
    );
  }

  return finalize(qty, limits, reasons);
}

/** Clamp a quantity down to `cap`, honoring fractional rules, and record why. */
function clampQty(
  current: number,
  cap: number,
  limits: PolicyLimits,
  reasons: string[],
  reason: string,
): number {
  const clamped = Math.min(current, cap);
  reasons.push(reason);
  return clamped;
}

/** Apply the fractional rule and decide allow vs clamp vs reject on the final qty. */
function finalize(qty: number, limits: PolicyLimits, reasons: string[]): RiskVerdict {
  let finalQty = qty;
  if (!limits.allowFractional) {
    finalQty = Math.floor(finalQty);
    if (finalQty <= 0) {
      return {
        decision: "reject",
        qty: 0,
        reasons: [...reasons, "whole-share size rounds to 0 (fractional disabled)"],
      };
    }
  } else {
    // Round to a sane fractional precision (6 dp) to avoid float dust.
    finalQty = Math.floor(finalQty * 1e6) / 1e6;
  }
  if (!(finalQty > 0)) {
    return { decision: "reject", qty: 0, reasons: [...reasons, "final quantity is 0"] };
  }
  return { decision: reasons.length > 0 ? "clamp" : "allow", qty: finalQty, reasons };
}
