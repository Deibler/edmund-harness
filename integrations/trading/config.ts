/**
 * `[trading]` configuration for the trading integration.
 *
 * The schema lives HERE, with the package, rather than in core's
 * `src/config/config.ts`. Core keeps the raw `[trading]` table from config.toml
 * as an opaque value and never validates or types it — that is what lets this
 * integration be deleted without touching the core schema.
 *
 * Call `tradingConfig(config)` to get a validated, typed view. Results are memoized
 * per Config object, so repeated calls on a hot path cost one WeakMap lookup.
 */

import { z } from "zod";
import { defineSection } from "../../src/integrations/section.ts";

export const Schema = z
  .object({
    /** Master switch. False = no routing, no watcher, no tools. */
    enabled: z.boolean().default(false),
    /** The ONLY handles that may reach the trading persona (phone/email,
     *  normalized via normalizeHandle). Independent of allowlist.dm. */
    handles: z.array(z.string()).default([]),
    /** Trigger words that switch an eligible handle into the trading
     *  session (e.g. "trader, buy ..."). Sticky until "<name> off". */
    trigger_names: z.array(z.string()).default(["trader", "quant"]),
    /** Model for the trading persona — SEPARATE from edmund's. Empty =
     *  inherit config.claude.model. Lets you run Quant on a different model
     *  (e.g. a cheaper one for frequent scans, or a sharper one for trades). */
    model: z.string().default(""),
    /** Effort for the trading persona. Empty = inherit config.claude.effort. */
    effort: z.enum(["", "low", "medium", "high", "xhigh", "max"]).default(""),
    /** Price-trigger watcher poll cadence (seconds). */
    poll_interval_seconds: z.number().int().positive().default(60),
    /** IANA tz for market-hours scheduling and the daily loss-breaker reset. */
    timezone: z.string().default("America/New_York"),
    /** Robinhood brokerage account number used for all broker calls. MUST be
     *  agentic_allowed=true (non-agentic accounts are rejected by the order
     *  API). The bot uses this deterministically; it never guesses. */
    account_number: z.string().default(""),
    // ---- Operational limits surfaced into the agent's system prompt CONFIG
    //      (rendered by buildTradingSystemPrompt). One source of truth here. ----
    /** Never let settled cash drop below this (USD reserve). */
    cash_floor: z.number().nonnegative().default(5),
    /** Max % of portfolio value in any single name. */
    max_position_pct: z.number().min(0).max(100).default(25),
    /** Hard dollar ceiling on any single order (whichever is tighter wins). */
    max_order_usd: z.number().nonnegative().default(12),
    /** Hard cap on orders placed in one invocation (runaway-loop guard). */
    max_orders_per_run: z.number().int().positive().default(3),
    /** If portfolio value falls below this, stop trading and only report. */
    kill_nav: z.number().nonnegative().default(0),
    /** Use marketable limit orders (price protection) vs plain market. */
    prefer_limit: z.boolean().default(true),
    /** "open" = any US stock/ETF, or a constrained ticker list (comma-sep). */
    universe: z.string().default("open"),
    /** The hosted Robinhood MCP (Streamable HTTP, OAuth-protected). The
     *  trading loadout loads this as an `http` MCP server so the session
     *  model gets the Robinhood tools (Claude Code manages the OAuth). */
    mcp_url: z.string().default("https://agent.robinhood.com/mcp/trading"),
    /** Optional headers for the Robinhood MCP (e.g. a bearer token for
     *  code-level access by the daemon/dashboard). The model-in-session
     *  path authenticates via Claude Code's MCP OAuth and needs none. */
    mcp_headers: z.record(z.string()).default({}),
    /** Execution mode.
     *   "auto"       — use the code-level HTTP broker if mcp_headers carry
     *                  auth (single-path, idempotent); else directive mode.
     *   "in_session" — the session model places orders via the Robinhood MCP
     *                  tools; code only risk-gates + journals (directive mode).
     *   "http_code"  — force the code-level HTTP broker (requires auth). */
    broker: z.enum(["auto", "in_session", "http_code"]).default("auto"),
    /**
     * Let execute_trade evaluate the risk policy on equity, cash, price and
     * position numbers the MODEL supplies (fetched through its own broker
     * tools) when no code-level broker is configured. Off by default: the
     * policy is only as good as its inputs, and a model that wants a trade
     * approved controls every one of them. With a code-level broker the
     * daemon fetches the numbers itself and this flag is irrelevant.
     */
    allow_model_supplied_risk_inputs: z.boolean().default(false),
    /** Dedicated trading dashboard port (separate from the main one). */
    dashboard_port: z.number().int().positive().default(4848),
    /** Raw MCP server entries merged verbatim into data/mcp-trading.json —
     *  the slot for the Robinhood stdio server the trading loadout loads. */
    mcp_servers: z.record(z.unknown()).default({}),
  })
  .default({});

export type TradingConfig = z.infer<typeof Schema>;

/**
 * Validated `[trading]` settings, memoized per Config object. A missing or
 * malformed table degrades to schema defaults (and logs) instead of
 * preventing the daemon from booting.
 */
export const tradingConfig = defineSection("trading", Schema);
