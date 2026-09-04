# Quant — autonomous Robinhood trading bot

A dedicated trading sub-persona inside edmund-harness. Reachable in iMessage
ONLY by Jordan's handles. Researches, decides, and executes **real trades**
fully autonomously within deterministic, code-enforced risk limits. Steered by
chatting; self-schedules; price triggers; dedicated dashboard.

## Architecture (where things live)

- **Routing** — `integrations/trading/src/route.ts` (`tradingGate`) + `src/main.ts`. An
  eligible handle that says "trader …"/"quant …" is keyed into the
  `trading:dm:<handle>` namespace (sticky until "trader off"). Restriction to
  the two handles is enforced here, independent of `allowlist.dm`.
- **Loadout** — `src/claude/mcp-config.ts` writes `data/mcp-trading.json`
  (edmund-harness server + the Robinhood HTTP MCP). `runner.ts` selects it for
  trading sessions; `system-prompt.ts` loads `persona/trading/*`.
- **Risk engine** — `integrations/trading/src/risk.ts` (pure, unit-tested in
  `tests/trading/risk.test.ts`). PRIMARY limit: max % of equity per position.
- **Policy** — `integrations/trading/src/policy.ts` → `data/trading/policy.{json,md}`.
  Edited by chatting (`update_policy`) or the dashboard.
- **Execution** — `integrations/trading/src/execute.ts` (`executeOrder`), the ONLY order
  path. Journals everything; idempotent via a UUID `ref_id`.
- **Broker** — `integrations/trading/src/broker.ts` + `brokers/http.ts` (MCP client to the
  hosted Robinhood MCP). Two modes: code-level (needs a bearer token) or
  in-session directive (model places, code risk-gates). The probe picks.
- **Triggers** — `integrations/trading/src/trigger-store.ts` + `trigger-watcher.ts` (wired
  in `main.ts`). Fires a one-shot cron systemEvent into the trading session.
- **Tools** — `integrations/trading/tools.ts` (self-gated to trading sessions).
- **Skill** — `skills/trading-loop/SKILL.md` (the decision loop).
- **Dashboard** — `integrations/trading/dashboard/` (Hono, PIN-gated, port 4848).
- **Probe** — `scripts/verify-broker.ts` (`bun run trading:verify`).

## Go-live checklist

1. **Robinhood: enable agentic trading** and get your **agentic_allowed=true**
   account number. Put it in `config.toml` → `[trading].account_number`.

2. **Authenticate the Robinhood MCP once (interactive).** Headless `claude -p`
   can't do the OAuth dance, so do it once and the token caches for headless
   reuse:
   ```
   claude mcp add --transport http robinhood https://agent.robinhood.com/mcp/trading
   claude            # then run /mcp and complete the Robinhood OAuth login
   ```
   (Alternatively, if you have a bearer token, put it under
   `[trading.mcp_headers] Authorization = "Bearer …"` to enable the code-level
   broker — that also powers the dashboard's live data and the price-quote
   watcher.)

3. **Set the dashboard PIN** (shared with the main dashboard):
   `bun run dashboard:set-pin <pin>`.

4. **Probe:** `bun run trading:verify` — confirms the broker path
   (CODE-LEVEL OK or IN-SESSION MODE). Either is fine to run.

5. **Dashboard is a managed launchd service** (`com.edmund-harness.trading`),
   controlled by the `edmund` CLI alongside the daemon + main dashboard:
   - `edmund start` / `stop` / `restart` / `status` / `kill` (no flag) cover all
     three; `edmund restart --trading` targets just it. Serves http://localhost:4848.
   - Install once with `edmund start --trading` (or it comes up with `edmund start`).

6. **Restart the daemon** so routing + the trigger watcher load:
   `launchctl kickstart -k gui/$(id -u)/com.skystream.app` is NOT this app —
   use the edmund-harness restart (`bun run dev`, or its LaunchAgent).

7. **From iMessage (Jordan's number):** text `trader status`. Confirm it
   answers as Quant. Set guidance: `trader, keep $20 cash floor, max 30% per
   name, avoid crypto` → check the dashboard Policy tab updated.

8. **First live trade** should be tiny. Quant will `propose_trade` →
   `execute_trade` → place via the Robinhood tool → `confirm_order`. Verify it
   appears in the Orders/Journal tabs. Flip the kill switch and confirm the
   next attempt is refused.

## Safety model (real money, no per-trade approval)

- Deterministic `riskCheck` clamps/rejects every order before the broker.
- Kill switch (`set_kill_switch` / dashboard) and daily-loss breaker halt trading.
- `%`-of-equity cap is the spine on a small account (default 30%).
- Single execution path + UUID idempotency; sub-agents research but never trade.
- Full audit log; Quant texts Jordan on fills, refusals, breaches, daily summary.

## Where the risk check's numbers come from

`execute_trade` evaluates the policy in `integrations/trading/src/risk.ts` on
equity, cash, the quote and the current position. With a code-level broker
configured (`[trading].mcp_headers` carrying auth, or `broker = "http_code"`),
the daemon fetches those itself, evaluates, and places the checked order; the
model's snapshot is ignored. Without one, the only path to the broker is the
model's own tools, and the check would run on numbers the model supplied. That
is refused unless `[trading].allow_model_supplied_risk_inputs = true`. Read the
flag's comment in `config.ts` before turning it on.

The dashboard escapes every value that came from the model or the broker
before rendering it.
