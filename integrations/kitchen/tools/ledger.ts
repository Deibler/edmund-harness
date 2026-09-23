/**
 * Writing the ledger: recording what arrived, was eaten, corrected or thrown
 * out, and retracting a batch. One call is one batch, so one undo reverses it.
 */

import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import { addTo, emptyTotal } from "../src/nutrition.ts";
import { settleAfterPurchase } from "../src/shopping.ts";
import { append, droppedBatches, fold, match, readLog, resolveOne, slug } from "../src/store.ts";
import { CATEGORIES, LEVELS, LOCATIONS } from "../src/types.ts";
import { Acct, text, withAccount } from "./shared.ts";

const Entry = z.object({
  op: z
    .enum(["add", "use", "set", "toss"])
    .describe(
      "add = it arrived. use = it got consumed. set = correct the record to an " +
        "observed truth. toss = it was thrown out.",
    ),
  item: z.string().describe("Item name. For use/set/toss it must name a tracked item exactly."),
  qty: z
    .number()
    .nullable()
    .optional()
    .describe("Amount. For `use`, null or omitted means all of it."),
  unit: z.string().optional(),
  name: z.string().optional().describe("Display name, when adding something new."),
  category: z.enum(CATEGORIES).optional(),
  location: z.enum(LOCATIONS).optional(),
  level: z
    .enum(LEVELS)
    .optional()
    .describe(
      "For things nobody counts (spices, oils, flour). Use INSTEAD of qty, never a fake number.",
    ),
  expires: z
    .string()
    .nullable()
    .optional()
    .describe(
      "YYYY-MM-DD printed on the package, and only that. Never estimate one: the kitchen " +
        "reasons about shelf life itself, and a guessed date reads as a fact.",
    ),
  aliases: z.array(z.string()).optional(),
  price: z
    .number()
    .optional()
    .describe(
      "What THIS LINE cost on the receipt — the money that left, NOT a per-unit rate. " +
        "Never divide a package price by how many are inside: a $1.46 dozen stocked as " +
        "qty 12 is price 1.46, not 0.12. Line totals must sum to the receipt total. " +
        "Powers spend tracking for free.",
    ),
  store: z.string().optional().describe("Store it came from, e.g. 'giant'."),
});

export function ledgerTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "kitchen_record",
      description:
        "Write to the ledger: groceries arriving, a meal getting cooked, a correction, " +
        "something thrown out. Everything in one call becomes ONE batch, so a whole " +
        "receipt or a whole dinner can be retracted as a unit. Log in the same turn the " +
        "change happens — an unlogged change quietly rots every future answer. Include " +
        "`price` on receipt items and spend tracking comes for free.",
      inputSchema: z.object({
        account: Acct,
        why: z.string().describe("What this was, e.g. 'sushi bake' or 'Giant run 8/15'."),
        source: z
          .string()
          .optional()
          .describe(
            "e.g. 'receipt:giant-2026-08-15', 'trip:aldi-2026-01-12' for a shop with no " +
              "receipt, 'cooked', 'photo'. Only receipt: and trip: sources count as a shopping " +
              "trip, which is what ends a 'not this trip' skip.",
          ),
        entries: z.array(Entry).min(1),
      }),
      handler: ({ account, why, source, entries }) =>
        withAccount(ctx, account, (id) => {
          const items = fold(id);
          const evs = [];
          const said: string[] = [];
          for (const e of entries) {
            const fields: Record<string, unknown> = {};
            if (e.name) fields.name = e.name;
            if (e.category) fields.cat = e.category;
            if (e.location) fields.loc = e.location;
            if (e.unit) fields.unit = e.unit;
            if (e.level) fields.level = e.level;
            if (e.expires !== undefined) fields.expires = e.expires;
            if (e.aliases) fields.aliases = e.aliases;
            if (e.price !== undefined) fields.price = e.price;
            if (e.store) fields.store = e.store;

            let itemId: string;
            if (e.op === "add" || e.op === "set") {
              const ex = match(e.item, items).exact;
              itemId = ex.length === 1 ? ex[0]!.id : slug(e.item);
              if (!fields.name) fields.name = ex.length === 1 ? ex[0]!.name : e.item;
            } else {
              // use/toss resolve strictly: "eggs" must never decrement "wide egg noodles".
              itemId = resolveOne(e.item, items).id;
            }
            evs.push({
              op: e.op,
              item: itemId,
              qty: e.op === "toss" ? 0 : (e.qty ?? null),
              unit: e.unit ?? null,
              fields,
              why,
              src: source ?? (e.op === "use" ? "cooked" : "manual"),
            });
            said.push(`${e.op} ${fields.name ?? itemId}`);
          }
          const batch = append(id, evs);
          const after = fold(id);
          const totals = emptyTotal();
          for (const e of evs) {
            if (e.op === "use")
              addTo(totals, e.item, e.qty, after[e.item]?.cat, e.unit, after[e.item]?.unit);
          }
          const kcal =
            totals.kcal > 0
              ? `\nEstimated ${Math.round(totals.kcal)} kcal consumed (derived, not measured).`
              : "";
          // A receipt settles the list, so a list nobody ticked still clears itself.
          const arrived = evs.filter((e) => e.op === "add").map((e) => e.item);
          const settled = arrived.length ? settleAfterPurchase(id, arrived) : null;
          const listNote = settled
            ? `\nShopping list: ${
                settled.cleared.length ? `cleared ${settled.cleared.join(", ")}. ` : ""
              }${settled.outstanding.length} line(s) still outstanding.`
            : "";
          return text(
            `Logged ${evs.length} change(s) as batch ${batch}: ${said.join(", ")}.${kcal}${listNote}\nRetract with kitchen_undo and this batch id if any of it was wrong.`,
          );
        }),
    },

    {
      name: "kitchen_undo",
      description:
        "Retract a whole batch — the unit a single kitchen_record wrote. Use when a " +
        "meal did not actually happen, or a receipt was transcribed wrong.",
      inputSchema: z.object({
        account: Acct,
        batch: z.string().optional().describe("Batch id. Omit to drop the most recent write."),
        why: z.string().optional(),
      }),
      handler: ({ account, batch, why }) =>
        withAccount(ctx, account, (id) => {
          const evs = readLog(id);
          if (!evs.length) return text("That household's ledger is empty.", true);
          const already = droppedBatches(evs);
          // A bare undo takes back the newest batch that still counts, so a second
          // undo never re-targets one already retracted.
          const target =
            batch ??
            [...evs].reverse().find((e) => e.op !== "undo" && !already.has(e.batch))?.batch;
          if (!target) {
            return text(
              "Nothing left to undo — every batch in this ledger is already retracted.",
              true,
            );
          }
          // Refuse a batch id that does not exist rather than report a write that
          // changed nothing.
          if (!evs.some((e) => e.batch === target && e.op !== "undo")) {
            return text(
              `No batch "${target}" in this household's ledger, so nothing was retracted. Batch ids come back from kitchen_record; omit this argument to undo the most recent write.`,
              true,
            );
          }
          if (already.has(target)) {
            return text(`Batch ${target} is already retracted; nothing changed.`, true);
          }
          append(id, [{ op: "undo", batch_target: target, item: null, why: why ?? "undo" }]);
          return text(`Dropped batch ${target}. The fold now skips every event in it.`);
        }),
    },
  ];
}
