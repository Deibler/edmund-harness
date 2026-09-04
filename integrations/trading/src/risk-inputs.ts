/**
 * Where the numbers the risk policy is evaluated on come from.
 *
 * The policy in risk.ts is deterministic, but it is only a control if its
 * inputs are. When a code-level broker exists the daemon fetches equity,
 * cash, positions and the quote itself and the model's copy is ignored.
 * When the model is the only path to the broker, using its numbers is a
 * choice the operator has to make explicitly in config.
 */

import type { Broker, BrokerBackend } from "./broker.ts";

export type RiskInputSource = "broker" | "model" | "refuse";

export function riskInputSource(
  backend: BrokerBackend,
  broker: Broker | null,
  allowModelSupplied: boolean,
): RiskInputSource {
  if (backend === "http_code" && broker) return "broker";
  return allowModelSupplied ? "model" : "refuse";
}

export const MODEL_INPUTS_REFUSAL =
  "REFUSED — no code-level broker is configured, so the risk check would run on numbers you supplied. " +
  "Either configure [trading].mcp_headers so the daemon can fetch account state itself, or set " +
  "[trading].allow_model_supplied_risk_inputs = true to accept that tradeoff. Nothing was placed.";
