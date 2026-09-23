/**
 * Planning a meal against live stock, and resolving the plan once somebody
 * says whether it was cooked. Nothing leaves the shelves until then.
 */

import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import { eaterCount, getAccount } from "../src/accounts.ts";
import { addTo, emptyTotal } from "../src/nutrition.ts";
import { confirmPlan } from "../src/plans.ts";
import { append, fold, match, newPlanId, nowIso, openPlans } from "../src/store.ts";
import type { Plan, PlanLine } from "../src/types.ts";
import { table } from "../src/util.ts";
import { Acct, text, withAccount } from "./shared.ts";

export function planningTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "kitchen_plan",
      description:
        "Check a meal against live stock BEFORE writing a recipe, and open a plan that " +
        "consumes nothing until someone confirms the food was actually made. Refuses on " +
        "anything the household does not have, which is what stops a recipe calling for " +
        "an ingredient that is not in the house. Returns a calorie estimate for free.",
      inputSchema: z.object({
        account: Acct,
        meal: z.string(),
        when: z.string().optional().describe("e.g. 'tonight', 'Monday dinner'."),
        uses: z
          .array(
            z.object({
              item: z.string(),
              qty: z.number().nullable().optional().describe("null = all of it"),
            }),
          )
          .min(1),
        force: z
          .boolean()
          .optional()
          .describe("Only when a human has confirmed the item exists and the ledger is wrong."),
      }),
      handler: ({ account, meal, when, uses, force }) =>
        withAccount(ctx, account, (id) => {
          const items = fold(id);
          const lines: PlanLine[] = [];
          const missing: string[] = [];
          for (const u of uses) {
            const m = match(u.item, items);
            const hits = m.exact.filter((h) => !h.gone);
            if (!hits.length) {
              const near = m.near
                .filter((h) => !h.gone)
                .slice(0, 3)
                .map((h) => h.name);
              missing.push(u.item + (near.length ? ` (not ${near.join(", ")})` : ""));
              continue;
            }
            if (hits.length > 1)
              return text(`"${u.item}" is ambiguous: ${hits.map((h) => h.id).join(", ")}`, true);
            const it = hits[0]!;
            const qty = u.qty ?? null;
            lines.push({
              item: it.id,
              name: it.name,
              qty,
              unit: it.unit,
              have: it.qty,
              short: qty !== null && it.qty !== null && it.qty < qty,
            });
          }
          const short = lines.filter((l) => l.short);
          if ((missing.length || short.length) && !force) {
            return text(
              [
                missing.length ? `Not in this kitchen: ${missing.join("; ")}` : "",
                short.length
                  ? `Not enough: ${short.map((l) => `${l.name} (has ${l.have}, needs ${l.qty})`).join("; ")}`
                  : "",
                "",
                "Change the recipe, add the item if it really is there, or pass force.",
              ]
                .filter(Boolean)
                .join("\n"),
              true,
            );
          }
          const totals = emptyTotal();
          // A plan line's qty is in the item's own unit, so pass it on both sides.
          for (const l of lines)
            addTo(totals, l.item, l.qty, items[l.item]?.cat, l.unit, items[l.item]?.unit);
          const plan: Plan = {
            id: newPlanId(),
            meal,
            when: when ?? null,
            lines,
            created: nowIso(),
            kcal: Math.round(totals.kcal),
            by: ctx.sessionKey ?? null,
          };
          append(id, [{ op: "plan", item: null, plan, why: meal, src: "plan" }]);
          const people = eaterCount(getAccount(id)!);
          return text(
            `Plan ${plan.id}: ${meal}${when ? ` (${when})` : ""}\n${table(
              lines.map((l) => [l.name, l.qty === null ? "all" : String(l.qty)]),
              ["item", "needs"],
            )}\n\nAbout ${Math.round(totals.kcal)} kcal total, ~${Math.round(totals.kcal / people)} each (derived from a nutrition table, not measured).\nNothing has come off the shelves. Confirm with kitchen_plan_resolve when it is actually cooked.`,
          );
        }),
    },

    {
      name: "kitchen_plan_resolve",
      description:
        "Confirm a planned meal actually got made (consuming its ingredients) or cancel " +
        "it (consuming nothing). Sending someone a recipe is not evidence anyone cooked it, " +
        "so nothing leaves the shelves until a human says it happened.",
      inputSchema: z.object({
        account: Acct,
        plan: z.string(),
        made: z.boolean(),
        why: z.string().optional(),
      }),
      handler: ({ account, plan, made, why }) =>
        withAccount(ctx, account, (id) => {
          const p = openPlans(id)[plan];
          if (!p) return text(`No open plan "${plan}".`, true);
          if (!made) {
            append(id, [
              { op: "plan_void", item: null, plan_id: plan, why: why ?? "never made", src: "plan" },
            ]);
            return text(`Dropped plan ${plan} (${p.meal}). Nothing was consumed.`);
          }
          // The same confirmation the site uses, so leftovers are written here too.
          const done = confirmPlan(id, plan, p);
          return text(
            `Confirmed "${p.meal}". ${done.items} items came off the shelves${done.yields ? `, ${done.yields} leftover(s) went in the fridge.` : "."}`,
          );
        }),
    },
  ];
}
