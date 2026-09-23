/**
 * Kitchen integration: typed tools over the per-household ledger.
 *
 * Every argument is validated before anything touches the append-only log, and
 * the household is resolved from the calling chat session, so no tool can span
 * two households. The tools live in `tools/`, one module per area; this file
 * assembles them in the order the model sees them.
 */

import type { ToolContext } from "../../src/mcp/context.ts";
import type { ToolDef } from "../../src/mcp/tools/types.ts";
import { kitchenConfig } from "./config.ts";
import { applyKitchenConfig } from "./src/settings.ts";
import { householdTools } from "./tools/household.ts";
import { insightsTools } from "./tools/insights.ts";
import { judgementTools } from "./tools/judgement.ts";
import { ledgerTools } from "./tools/ledger.ts";
import { onboardTools } from "./tools/onboard.ts";
import { planningTools } from "./tools/planning.ts";
import { readTools } from "./tools/read.ts";
import { recipeTools } from "./tools/recipes.ts";
import { requestTools } from "./tools/requests.ts";
import { shelfTools } from "./tools/shelf.ts";
import { shoppingTools } from "./tools/shopping.ts";

export function kitchenTools(ctx: ToolContext): ToolDef[] {
  if (!kitchenConfig(ctx.config)?.enabled) return [];
  // `dir` and `price_max_age_days` take effect only once applied.
  applyKitchenConfig(ctx.config);
  return [
    ...readTools(ctx),
    ...ledgerTools(ctx),
    ...planningTools(ctx),
    ...insightsTools(ctx),
    ...shoppingTools(ctx),
    ...householdTools(ctx),
    ...recipeTools(ctx),
    ...requestTools(ctx),
    ...shelfTools(ctx),
    ...onboardTools(ctx),
    ...judgementTools(ctx),
  ];
}
