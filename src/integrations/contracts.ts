/**
 * Type contracts for optional integrations.
 *
 * Core needs the *shape* of a few integration exports to call them, but must
 * not import the integration itself — that would make an optional package a
 * build dependency. These declarations live core-side so `src/` compiles
 * whether or not any integration directory is present.
 *
 * The cost is that a contract can drift from its implementation without the
 * compiler noticing. Two things bound that: the manifests name the exports
 * (so a rename is visible in review), and the registry logs loudly at runtime
 * when a declared export is missing.
 *
 * Keep this file tiny. A growing contract surface means core is leaning on
 * integrations too hard — the fix is to move the logic behind a narrower seam,
 * not to add another type here.
 */

import type { Config } from "../config/config.ts";
import type { InboundMessage } from "../imessage/types.ts";
import type { StateStore } from "../sessions/store.ts";

/** Result of the trading router gate. */
type TradingRoute = { route: "trading" | "normal" };

/**
 * `tradingGate` from the trading integration. Decides whether an inbound
 * belongs to the trading sub-persona. Absent integration ⇒ nothing routes to
 * trading, which is the correct behavior for a harness without it.
 */
export type TradingGateFn = (
  msg: InboundMessage,
  config: Config,
  state: StateStore,
) => TradingRoute;

/**
 * `mirrorEnvelopeBlock` from the mirror integration. Returns the channel
 * guidance block (component catalog + live glass inventory) appended to a
 * mirror turn's envelope. Absent integration ⇒ no block, and no mirror
 * sessions exist to need one.
 */
export type MirrorEnvelopeBlockFn = (config: Config) => string;
