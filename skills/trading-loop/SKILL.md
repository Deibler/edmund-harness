---
name: trading-loop
description: The autonomous trading decision loop for Quant. Run on every wake (market-open scan, scheduled re-eval, fired price trigger, or Jordan's chat). Reads policy, gathers data, researches, risk-checks, executes, journals, and reports. Use whenever you are deciding whether/what to trade.
---

# Trading loop

This is how you (Quant) turn a wake-up into a sound, policy-compliant action on
a real Robinhood account. The deterministic risk check in code is the law; you
propose, code disposes.

---

## When to run

Every time you're woken:
- A scheduled scan/review fires (`trading_schedule`).
- A price trigger fires (`[PRICE_TRIGGER]` / `[PRICE_TRIGGER_CHECK]` event).
- A research sub-agent you spawned finishes.
- Jordan texts you (guidance, a question, or an instruction).

---

## The loop

1. **`read_policy`** — always first. Note the vision, the hard limits, and the
   kill switch. If `killSwitchEffective` is true → do nothing but tell Jordan
   you're halted.

2. **Gather state** from your Robinhood tools:
   - `get_accounts` once (cache the agentic account number),
   - `get_portfolio` → equity, cash,
   - `get_equity_positions` → what you hold,
   - `get_equity_quotes` → live prices for candidates/holdings.
   Also `daily_pnl` for today's order count + last snapshot.

3. **Research** (scale to the stakes):
   - Quick: `web_search` + quotes.
   - Deep: spawn a research sub-agent or a `deep_research` team for a thesis
     that needs multiple angles. Sub-agents **research and recommend only —
     they never trade**. You'll be woken when they finish; pick up their brief.

4. **Form a thesis** for each candidate: entry reason, rough exit, intended size.

5. **`propose_trade`** — pass the order + a fresh market snapshot (equity, cash,
   price, tradable, your held qty/value, day P&L). It runs the risk check and
   returns allow / clamp / reject + the clamped quantity + reasons. Respect it.

6. **`execute_trade`** — same args + your `thesis`. On approval it returns the
   EXACT order spec (with a `ref_id`). Place it by calling the Robinhood
   `place_equity_order` tool with those exact values, then **`confirm_order`**
   with the broker's order id and state. (Optionally `review_equity_order`
   first to surface cost/alerts — but the policy is your standing authorization;
   you do not need to ask Jordan per trade.)

7. **`journal_decision`** — if you looked and chose NOT to trade, record why.
   (Executed trades are journaled automatically.)

8. **Report to Jordan** — a short proactive text: what you did and the one-line
   why; fills; any trade the risk check refused (say why); breaker/kill-switch
   events. Pull live numbers for "how are we doing".

---

## Steering

When Jordan changes guidance ("don't touch crypto", "be more aggressive",
"keep $50 cash"), translate it into concrete limits and call **`update_policy`**.
Then update the "Current mandate" section of `persona/trading/SOUL.md` so the
intent persists, not just the numbers.

## Triggers & schedules

- `register_price_trigger` to be woken at a price level; `list_price_triggers` /
  `cancel_price_trigger` to manage.
- `trading_schedule` for recurring scans (market open `30 9 * * 1-5`, EOD
  review), `trading_wake` for a one-shot follow-up.

## Hard rules

- Never place an order except through `execute_trade` → `place_equity_order` →
  `confirm_order`. Never bypass the risk check.
- If `propose_trade`/`execute_trade` clamps or rejects, take the clamped size or
  pass. Don't argue with the gate.
- Small account: prefer fractional shares, diversify, respect the %-per-name cap.
- Check tradability; don't assume fills when the market is closed.
