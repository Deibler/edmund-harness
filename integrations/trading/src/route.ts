import type { Config } from "../../../src/config/config.ts";
import type { InboundMessage } from "../../../src/imessage/types.ts";
import { normalizeHandle } from "../../../src/sessions/key.ts";
import type { StateStore } from "../../../src/sessions/store.ts";
import { tradingConfig } from "../config.ts";

/**
 * Trading-routing decision — the single auditable place that decides whether
 * an inbound message belongs to the autonomous trading sub-persona.
 *
 * The two-handle restriction lives HERE, before the session key is rewritten
 * in `main.ts`, and is independent of `allowlist.dm` (which is empty = allow
 * all for edmund). A non-trading handle can never reach the trading persona,
 * its tools, or the broker — no matter what they type.
 *
 * Routing model: per-message, by name only. An eligible handle reaches the
 * trading persona ONLY by leading that message with a trigger word
 * ("wolf, buy 1 AAPL"). Everything else — including follow-ups right after
 * a trading exchange — goes to edmund. There is no stickiness: the owner
 * asked for the default to always be edmund unless the name is used
 * (2026-06-10), after sticky mode left his DM trapped in the trading
 * persona for plain messages like "Howdy".
 */

export type TradingRoute = { route: "trading" | "normal" };

/** Legacy stickiness flag key (pre-2026-06-10 router) — only used to clear. */
function stickyKey(handle: string): string {
  return `trading_sticky:${normalizeHandle(handle)}`;
}

function isEligible(msg: InboundMessage, config: Config): boolean {
  if (!tradingConfig(config).enabled) return false;
  // DM-ONLY, BY DESIGN: the trading persona never operates in a group chat. A
  // group is a shared room — operating there could expose the portfolio to
  // others and would let the bot see non-owner messages. Trading lives only in
  // the owner's private 1-on-1 DM, where there is by definition no one else.
  if (msg.isGroup) return false;
  // Owner-only: the sender MUST be one of the configured trading handles. No
  // other person can invoke the trading persona or be seen by it, in any venue.
  const from = normalizeHandle(msg.fromHandle);
  return tradingConfig(config).handles.some((h) => normalizeHandle(h) === from);
}

/** A regex that can never match — used when there are no valid trigger names
 *  so an empty trigger can't accidentally route every message to trading. */
const NEVER = /$.^/;

/** Build the trigger regex once from config trigger names. */
function triggerPatterns(names: string[]): { enter: RegExp } {
  // Drop empty/whitespace entries: an empty alternative would make the enter
  // regex match the start of ANY message and hijack every inbound.
  const clean = names.map((n) => n.trim()).filter((n) => n.length > 0);
  if (clean.length === 0) return { enter: NEVER };
  const alt = clean.map((n) => escapeRegex(n.toLowerCase())).join("|");
  // "wolf ...", "@wolf ...", "hey wolf, ..." at the start of the message.
  const enter = new RegExp(`^\\s*(hey\\s+|ok\\s+|@)?(${alt})\\b[,:!.\\s]*`, "i");
  return { enter };
}

export function tradingGate(msg: InboundMessage, config: Config, state: StateStore): TradingRoute {
  if (!isEligible(msg, config)) return { route: "normal" };

  // Migration: clear any stickiness flag persisted by the old router so a
  // historic "wolf …" message can never influence routing again.
  if (state.getCursor(stickyKey(msg.fromHandle), 0) === 1) {
    state.setCursor(stickyKey(msg.fromHandle), 0);
  }

  const { enter } = triggerPatterns(tradingConfig(config).trigger_names);
  return { route: enter.test(msg.text ?? "") ? "trading" : "normal" };
}

/**
 * Strip a leading trigger word so the trading persona sees the actual
 * instruction ("trader, buy 1 AAPL" → "buy 1 AAPL"). Mirrors `stripMention`
 * in src/gating/allowlist.ts.
 */
function stripTradingTrigger(text: string, names: string[]): string {
  const { enter } = triggerPatterns(names);
  return text.replace(enter, "").trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
