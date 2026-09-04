import { join } from "node:path";
import { z } from "zod";
import { parseSchedule } from "../../src/cron/parse.ts";
import type { ToolContext } from "../../src/mcp/context.ts";
import type { ToolDef } from "../../src/mcp/tools/types.ts";
import { isTradingSession } from "../../src/sessions/key.ts";
import { tradingConfig } from "./config.ts";
import { getBroker } from "./src/broker.ts";
import { type MarketData, executeOrder } from "./src/execute.ts";
import { PolicyStore } from "./src/policy.ts";
import { MODEL_INPUTS_REFUSAL, riskInputSource } from "./src/risk-inputs.ts";
import { TradingStore } from "./src/store.ts";
import { TriggerStore } from "./src/trigger-store.ts";
import type { OrderRequest } from "./src/types.ts";

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Market snapshot the model supplies (fetched via its Robinhood MCP tools)
 * for the deterministic risk check. In code-broker deployments these can be
 * omitted and the daemon fetches them, but the default path is in-session.
 */
const MarketSchema = z.object({
  equity: z.number().describe("Total account equity (cash + positions), USD."),
  cash: z.number().describe("Cash available, USD."),
  price: z.number().describe("Current price of the symbol (last trade)."),
  tradable: z
    .boolean()
    .default(true)
    .describe("Is the symbol tradable right now (market open, not halted)?"),
  held_qty: z.number().default(0).describe("Shares of this symbol already held (0 if none)."),
  held_value: z
    .number()
    .default(0)
    .describe("Market value of the current position in this symbol, USD (0 if none)."),
  day_pnl: z.number().optional().describe("Account day P&L, USD (used for the loss breaker)."),
});

const OrderSchema = z.object({
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]).default("market"),
  qty: z
    .number()
    .positive()
    .optional()
    .describe("Share quantity (fractional allowed). Provide qty OR notional_usd."),
  notional_usd: z
    .number()
    .positive()
    .optional()
    .describe("Dollar amount to trade; resolved to shares at price."),
  limit_price: z.number().positive().optional().describe("Required for limit orders."),
});

function toOrderRequest(a: z.infer<typeof OrderSchema>): OrderRequest {
  return {
    symbol: a.symbol,
    side: a.side,
    type: a.type,
    qty: a.qty,
    notionalUSD: a.notional_usd,
    limitPrice: a.limit_price,
  };
}

function toMarket(symbol: string, m: z.infer<typeof MarketSchema>): MarketData {
  return {
    portfolio: { equity: m.equity, cash: m.cash, buyingPower: m.cash, dayPnL: m.day_pnl },
    positions:
      m.held_qty > 0
        ? [
            {
              symbol: symbol.toUpperCase(),
              quantity: m.held_qty,
              avgCost: 0,
              marketValue: m.held_value,
            },
          ]
        : [],
    quote: { symbol: symbol.toUpperCase(), last: m.price, tradable: m.tradable },
  };
}

export function tradingTools(ctx: ToolContext): ToolDef[] {
  // Defense-in-depth: these tools touch a real brokerage. If a mis-set session
  // key ever reaches here without being a trading session, refuse everything.
  if (!isTradingSession(ctx.sessionKey)) {
    return [];
  }
  // The trading stores are constructed HERE, not in core's ToolContext, so the
  // harness has no compile-time dependency on this package: deleting
  // integrations/trading/ leaves core building and simply removes these tools.
  const store = new TradingStore(ctx.dataDir);
  const triggers = new TriggerStore(ctx.dataDir);
  const policyStore = new PolicyStore(join(ctx.dataDir, "trading"));
  const now = () => Date.now();

  return [
    // ---- policy ---------------------------------------------------------
    {
      name: "read_policy",
      description:
        "Read the current trading policy: the operator's vision plus the hard, code-enforced limits (max % of equity per position, daily-loss limit, cash floor, etc.) and the kill-switch state. ALWAYS read this first on every decision.",
      inputSchema: z.object({}).optional(),
      handler: () => {
        const p = policyStore.read();
        const killed = store.getKillSwitch() || p.killSwitch;
        return text(JSON.stringify({ ...p, killSwitchEffective: killed }, null, 2));
      },
    },
    {
      name: "update_policy",
      description:
        "Persist a change to the trading policy when the operator changes their guidance in chat. Bumps the version and updates both the machine limits and the human-readable mandate. Pass only the fields that change.",
      inputSchema: z.object({
        vision: z
          .string()
          .optional()
          .describe("the operator's guidance in plain English (the 'why')."),
        max_pct_per_name: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Max fraction of equity per position, e.g. 0.30."),
        max_position_usd: z.number().nonnegative().optional(),
        daily_loss_limit_usd: z.number().nonnegative().optional(),
        max_trades_per_day: z.number().int().nonnegative().optional(),
        cash_floor_usd: z.number().nonnegative().optional(),
        allow_short: z.boolean().optional(),
        allow_fractional: z.boolean().optional(),
        allowed_symbols: z.array(z.string()).optional(),
        forbidden_symbols: z.array(z.string()).optional(),
      }),
      handler: (a) => {
        const limits: Record<string, unknown> = {};
        if (a.max_pct_per_name !== undefined) limits.maxPctPerName = a.max_pct_per_name;
        if (a.max_position_usd !== undefined) limits.maxPositionUSD = a.max_position_usd;
        if (a.daily_loss_limit_usd !== undefined) limits.dailyLossLimitUSD = a.daily_loss_limit_usd;
        if (a.max_trades_per_day !== undefined) limits.maxTradesPerDay = a.max_trades_per_day;
        if (a.cash_floor_usd !== undefined) limits.cashFloorUSD = a.cash_floor_usd;
        if (a.allow_short !== undefined) limits.allowShort = a.allow_short;
        if (a.allow_fractional !== undefined) limits.allowFractional = a.allow_fractional;
        if (a.allowed_symbols !== undefined) limits.allowedSymbols = a.allowed_symbols;
        if (a.forbidden_symbols !== undefined) limits.forbiddenSymbols = a.forbidden_symbols;
        const p = policyStore.write({ vision: a.vision, limits }, now());
        store.recordPolicyVersion(p.version, p.updatedAt, "jordan_chat", JSON.stringify(p), "");
        store.audit(now(), "jordan_chat", "policy_update", `v${p.version}`);
        return text(`policy updated to v${p.version}. Limits: ${JSON.stringify(p.limits)}`);
      },
    },

    // ---- risk-gated execution ------------------------------------------
    {
      name: "propose_trade",
      description:
        "Dry-run the deterministic risk check on a candidate order WITHOUT placing it. Pass the order and a fresh market snapshot (fetch equity/cash/price/your current position via your Robinhood tools). Returns allow/clamp/reject, the clamped quantity, and the reasons. Use this to size and sanity-check before execute_trade.",
      inputSchema: OrderSchema.extend({ market: MarketSchema }),
      handler: async (a) => {
        const result = await executeOrderDryRun(a);
        return text(JSON.stringify(result.verdict, null, 2));
      },
    },
    {
      name: "execute_trade",
      description:
        "Place a REAL order, but only after the deterministic risk check passes. With a code-level broker configured the daemon fetches account state and the quote itself, evaluates policy on those, and places the checked order; your market snapshot is ignored. Without one, the check runs on the snapshot you pass only if the operator has enabled [trading].allow_model_supplied_risk_inputs, and on approval you get back the EXACT order spec to send to the Robinhood `place_equity_order` tool (including the ref_id idempotency key) — place it with those exact values, then call confirm_order with the broker's order id. This is the only sanctioned execution path.",
      inputSchema: OrderSchema.extend({
        market: MarketSchema.optional(),
        thesis: z.string().describe("Your one-paragraph rationale for this trade — journaled."),
        wake_source: z
          .string()
          .default("chat")
          .describe("What prompted this: chat / market_open / reeval / price_trigger."),
      }),
      handler: async (a) => {
        const { backend, broker } = await getBroker(ctx.config);
        const source = riskInputSource(
          backend,
          broker,
          tradingConfig(ctx.config).allow_model_supplied_risk_inputs,
        );
        if (source === "refuse") {
          await broker?.close().catch(() => {});
          return text(MODEL_INPUTS_REFUSAL, true);
        }
        if (source === "model" && !a.market) {
          return text(
            "REFUSED — pass a fresh market snapshot (equity, cash, price, held_qty).",
            true,
          );
        }
        let res: Awaited<ReturnType<typeof executeOrder>>;
        try {
          res = await executeOrder(toOrderRequest(a), {
            store,
            policyStore,
            config: ctx.config,
            nowMs: now(),
            wakeSource: a.wake_source,
            thesis: a.thesis,
            // "broker": the daemon fetched the numbers and places the order.
            // "model": in-session directive mode; code risk-gates + journals.
            broker: source === "broker" ? broker : null,
            market: source === "model" && a.market ? toMarket(a.symbol, a.market) : undefined,
          });
        } finally {
          await broker?.close().catch(() => {});
        }
        if (res.mode === "rejected") {
          return text(`REJECTED — do not place. Reasons: ${res.verdict.reasons.join("; ")}`);
        }
        if (res.mode === "directive") {
          return text(
            [
              `RISK-APPROVED (${res.verdict.decision}). Place EXACTLY this via the Robinhood place_equity_order tool:`,
              JSON.stringify(res.place, null, 2),
              res.verdict.reasons.length ? `Adjustments: ${res.verdict.reasons.join("; ")}` : "",
              `Then call confirm_order(order_id="${res.orderId}", broker_order_id=<id from Robinhood>, status=<state>).`,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
        return text(
          `PLACED order ${res.orderId} status=${res.status} broker=${res.brokerOrderId ?? "?"}`,
        );
      },
    },
    {
      name: "confirm_order",
      description:
        "After you place an execute_trade-approved order via the Robinhood tool, report the result here to finalize the journal/order record. Pass the order_id from execute_trade and the broker's order id + state.",
      inputSchema: z.object({
        order_id: z.string(),
        broker_order_id: z.string().optional(),
        status: z
          .enum(["submitted", "filled", "partial", "canceled", "rejected", "failed"])
          .default("submitted"),
        filled_qty: z.number().optional(),
        avg_fill_price: z.number().optional(),
        error: z.string().optional(),
      }),
      handler: (a) => {
        const ord = store.getOrder(a.order_id);
        if (!ord) return text(`no order ${a.order_id}`, true);
        store.updateOrder(a.order_id, {
          status: a.status,
          brokerOrderId: a.broker_order_id ?? null,
          filledQty: a.filled_qty ?? null,
          avgFillPrice: a.avg_fill_price ?? null,
          filledAt: a.status === "filled" ? now() : null,
          error: a.error ?? null,
        });
        store.audit(now(), "loop_directive", "order_confirmed", `${a.order_id} → ${a.status}`);
        return text(`order ${a.order_id} recorded as ${a.status}`);
      },
    },

    // ---- journal --------------------------------------------------------
    {
      name: "journal_decision",
      description:
        "Record a decision that did NOT result in a trade (e.g. 'looked at NVDA, passed because X'). Trades placed via execute_trade are journaled automatically — use this for no-trade reasoning so the record is complete.",
      inputSchema: z.object({
        thesis: z.string(),
        wake_source: z.string().default("chat"),
        verdict: z.enum(["noop", "watch"]).default("noop"),
        research_ref: z.string().optional(),
      }),
      handler: (a) => {
        const p = policyStore.read();
        const id = store.recordDecision({
          createdAt: now(),
          wakeSource: a.wake_source,
          policyVersion: p.version,
          thesis: a.thesis,
          researchRef: a.research_ref ?? null,
          verdict: a.verdict,
        });
        return text(`journaled decision ${id}`);
      },
    },
    {
      name: "read_journal",
      description: "Read recent trading decisions and orders (your own track record).",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(30) }).optional(),
      handler: (a) => {
        const limit = a?.limit ?? 30;
        const decisions = store.listDecisions(limit);
        const orders = store.listOrders({ limit });
        return text(JSON.stringify({ decisions, orders }, null, 2));
      },
    },
    {
      name: "daily_pnl",
      description:
        "Latest portfolio snapshot + today's order count (for the loss breaker / trade-cap awareness).",
      inputSchema: z.object({}).optional(),
      handler: () => {
        const snap = store.latestSnapshot();
        return text(JSON.stringify({ snapshot: snap, killSwitch: store.getKillSwitch() }, null, 2));
      },
    },

    // ---- kill switch ----------------------------------------------------
    {
      name: "set_kill_switch",
      description:
        "Turn the trading kill switch on or off. When ON, no orders may be placed (the risk check rejects everything). Use when the operator says 'stop trading' / 'halt' / 'you can resume'.",
      inputSchema: z.object({ on: z.boolean(), reason: z.string().optional() }),
      handler: (a) => {
        store.setKillSwitch(a.on, now(), "jordan_chat");
        policyStore.write({ killSwitch: a.on }, now());
        return text(
          a.on
            ? `KILL SWITCH ON — trading halted${a.reason ? ` (${a.reason})` : ""}`
            : "kill switch off — trading resumed",
        );
      },
    },

    // ---- price triggers -------------------------------------------------
    {
      name: "register_price_trigger",
      description:
        "Arm a price trigger: wake this session when SYMBOL crosses THRESHOLD. Fires once. Use for 'ping me if TSLA drops below 200' or to schedule a re-evaluation at a price level.",
      inputSchema: z.object({
        symbol: z.string(),
        direction: z.enum(["above", "below"]),
        threshold: z.number().positive(),
        note: z.string().optional().describe("What you'll want to do when it fires."),
      }),
      handler: (a) => {
        const t = triggers.create({
          sessionKey: ctx.sessionKey,
          symbol: a.symbol,
          direction: a.direction,
          threshold: a.threshold,
          note: a.note,
        });
        return text(`armed trigger ${t.id}: ${t.symbol} ${t.direction} ${t.threshold}`);
      },
    },
    {
      name: "list_price_triggers",
      description: "List this session's price triggers (armed/fired/canceled).",
      inputSchema: z.object({}).optional(),
      handler: () => {
        const list = triggers.listForSession(ctx.sessionKey);
        if (list.length === 0) return text("no triggers");
        return text(
          list
            .map(
              (t) =>
                `${t.id}  ${t.symbol} ${t.direction} ${t.threshold}  [${t.status}]${t.note ? ` — ${t.note}` : ""}`,
            )
            .join("\n"),
        );
      },
    },
    {
      name: "cancel_price_trigger",
      description: "Cancel an armed price trigger by id.",
      inputSchema: z.object({ id: z.string() }),
      handler: (a) => {
        const ok = triggers.cancel(a.id, ctx.sessionKey);
        return text(ok ? `canceled ${a.id}` : `not found / not armed: ${a.id}`);
      },
    },

    // ---- self-scheduling ------------------------------------------------
    {
      name: "trading_schedule",
      description:
        "Schedule a recurring self-wake for autonomous work — a market-open scan, midday/EOD review, etc. Cron expression in the configured market timezone. The event text is what you'll receive when it fires.",
      inputSchema: z.object({
        when: z
          .string()
          .describe('5-field cron, e.g. "30 9 * * 1-5" (9:30 weekdays), or "in 30 minutes".'),
        event: z
          .string()
          .describe(
            "What you'll react to, e.g. 'Market-open scan: review watchlist and act per policy.'",
          ),
        grace_minutes: z.number().int().min(0).default(30),
      }),
      handler: (a) => {
        const schedule = parseSchedule(a.when);
        const job = ctx.cron.create({
          sessionKey: ctx.sessionKey,
          systemEvent: a.event,
          schedule,
          gracePeriodMs: a.grace_minutes * 60_000,
        });
        return text(`scheduled ${job.id} next=${new Date(job.nextFireMs).toISOString()}`);
      },
    },
    {
      name: "trading_wake",
      description:
        "One-shot self-poke: wake this session once at a future time to follow up on something.",
      inputSchema: z.object({
        when: z.string().describe('"in 30 minutes", "at 2026-06-09T15:55:00-04:00".'),
        event: z.string(),
      }),
      handler: (a) => {
        const schedule = parseSchedule(a.when);
        const job = ctx.cron.create({
          sessionKey: ctx.sessionKey,
          systemEvent: a.event,
          schedule,
          gracePeriodMs: null,
        });
        return text(`wake scheduled ${job.id} next=${new Date(job.nextFireMs).toISOString()}`);
      },
    },
    {
      name: "trading_list_wakes",
      description: "List this session's scheduled wakes / recurring scans.",
      inputSchema: z.object({}).optional(),
      handler: () => {
        const jobs = ctx.cron.listActive(ctx.sessionKey);
        if (jobs.length === 0) return text("no scheduled wakes");
        return text(
          jobs
            .map((j) => `${j.id}  next=${new Date(j.nextFireMs).toISOString()}  ${j.systemEvent}`)
            .join("\n"),
        );
      },
    },
    {
      name: "trading_cancel_wake",
      description: "Cancel a scheduled wake by id.",
      inputSchema: z.object({ id: z.string() }),
      handler: (a) => text(ctx.cron.cancel(a.id) ? `canceled ${a.id}` : `not found: ${a.id}`),
    },
  ];

  // Local helper: run the risk check only (no journal, no order row).
  async function executeOrderDryRun(
    a: z.infer<typeof OrderSchema> & { market: z.infer<typeof MarketSchema> },
  ) {
    // Reuse executeOrder's gate by calling it against an ephemeral path would
    // also journal — for a pure dry run we replicate just the risk check.
    const { riskCheck } = await import("./src/risk.ts");
    const p = policyStore.read();
    const market = toMarket(a.symbol, a.market);
    const daily = {
      realizedPnLToday: a.market.day_pnl ?? 0,
      tradesToday: store.countOrdersSince(now() - 24 * 3600 * 1000),
      killSwitch: store.getKillSwitch() || p.killSwitch,
      dailyLossTripped: false,
    };
    const verdict = riskCheck(
      toOrderRequest(a),
      p.limits,
      market.portfolio,
      market.positions,
      market.quote,
      daily,
    );
    return { verdict };
  }
}
