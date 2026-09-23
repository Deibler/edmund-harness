/**
 * Derived views over a household's history: recap, intake, spend, rhythm, and
 * the raw log.
 */

import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import { eaterCount, getAccount } from "../src/accounts.ts";
import { intake, kcalTarget, learnedSchedule, recap, spend } from "../src/insights.ts";
import { corruptLines, droppedBatches, readLog } from "../src/store.ts";
import { table } from "../src/util.ts";
import { Acct, text, withAccount } from "./shared.ts";

export function insightsTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "kitchen_insights",
      description:
        "Derived views over the household's history: the Wrapped-style recap, calorie " +
        "intake, grocery spend, and the meal rhythm (when they actually eat, which days " +
        "they batch-cook). All computed from the log — nobody entered any of it. Numbers " +
        "carry their confidence; present them as trends, not measurements.",
      inputSchema: z.object({
        account: Acct,
        view: z.enum(["recap", "intake", "spend", "rhythm", "log", "all"]).default("all"),
        days: z.number().optional().describe("Window. Recap defaults to 365, intake to 14."),
        limit: z.number().optional().describe("log view only: how many events. Default 25."),
      }),
      handler: ({ account, view, days, limit }) =>
        withAccount(ctx, account, (id) => {
          const acct = getAccount(id)!;
          const people = eaterCount(acct);
          const out: string[] = [];

          // The raw ledger, newest first, for when the derived numbers are in doubt.
          // Not part of "all". Retracted batches are marked, not hidden.
          if (view === "log") {
            const evs = readLog(id);
            const dropped = droppedBatches(evs);
            const rows = evs
              .slice(-(limit ?? 25))
              .reverse()
              .map((e) => [
                e.ts.slice(0, 16).replace("T", " "),
                e.batch,
                dropped.has(e.batch) ? "RETRACTED" : e.op,
                e.item ??
                  (e.plan_id ? `plan ${e.plan_id}` : e.batch_target ? `-> ${e.batch_target}` : ""),
                e.qty === null || e.qty === undefined
                  ? ""
                  : `${e.qty}${e.unit ? ` ${e.unit}` : ""}`,
                e.why ?? "",
              ]);
            out.push(
              `LEDGER (${evs.length} events, newest first)`,
              rows.length ? table(rows, ["when", "batch", "op", "item", "qty", "why"]) : "  empty",
              "",
            );
            const damaged = corruptLines.get(id) ?? [];
            if (damaged.length) {
              out.push(
                `  WARNING: ${damaged.length} unreadable line(s) skipped: ${damaged.join(", ")}`,
                "",
              );
            }
            return text(out.join("\n"));
          }

          if (view === "rhythm" || view === "all") {
            const s = learnedSchedule(id);
            out.push(
              "RHYTHM (derived)",
              s.dinnerHour === null
                ? `  ${s.basis}`
                : `  Usual dinner ~${s.dinnerHour}:00. ${s.mealsPerWeek ?? "?"} meals cooked per week.${s.prepDays.length ? `\n  Heaviest cooking: ${s.prepDays.join(", ")}.` : ""}\n  ${s.basis}.`,
              "",
            );
          }
          if (view === "intake" || view === "all") {
            const d = intake(id, days ?? 14, people);
            const t = kcalTarget(id, acct.diet?.kcal_target, people);
            out.push(
              `INTAKE (derived, split across ${people})`,
              t.target
                ? `  Reference ${t.target} kcal/day — ${t.source}.`
                : `  No target: ${t.source}.`,
              d.length
                ? table(
                    d.slice(-10).map((x) => [x.date, String(x.meals), String(Math.round(x.kcal))]),
                    ["day", "meals", "kcal each"],
                  )
                : "  No cooked meals logged in this window.",
              "",
            );
          }
          if (view === "spend" || view === "all") {
            const s = spend(id, days ?? 90);
            out.push(
              "SPEND",
              s.total
                ? `  $${s.total.toFixed(2)} across ${s.spanDays} day(s) of priced purchases${
                    s.perWeek
                      ? `, about $${s.perWeek.toFixed(2)}/week.`
                      : ` — under a week of history, so there is no weekly rate worth stating yet.`
                  }`
                : "  No prices captured yet.",
              `  Price coverage ${Math.round(s.coverage * 100)}% of purchased items${s.coverage < 0.9 ? " — the real total is higher than this." : "."}`,
              ...s.byStore.map(
                (b) => `    ${b.store}: $${b.total.toFixed(2)} over ${b.trips} trip(s)`,
              ),
              acct.budget
                ? `  Budget ${acct.budget}/week — ${
                    s.perWeek
                      ? s.perWeek > acct.budget
                        ? `over by $${(s.perWeek - acct.budget).toFixed(2)}`
                        : `under by $${(acct.budget - s.perWeek).toFixed(2)}`
                      : "no spend data to compare"
                  }`
                : "",
              "",
            );
          }
          if (view === "recap" || view === "all") {
            const r = recap(id, days ?? 365, people);
            out.push(
              "RECAP",
              `  ${r.headline}`,
              `  ${r.meals} meals, ${r.distinctMeals} different dishes.`,
              r.longestStreak
                ? `  Longest streak ${r.longestStreak.days} days (${r.longestStreak.from} to ${r.longestStreak.to}).`
                : "",
              r.topMeals.length
                ? `  Most cooked: ${r.topMeals.map((m) => `${m.name} (${m.times}x)`).join(", ")}`
                : "",
              r.topItems.length ? `  Most-used: ${r.topItems.map((t) => t.name).join(", ")}` : "",
              `  Waste ${Math.round(r.wasteRate * 100)}% of purchased items (${r.tossed.length} tossed).`,
              r.avgKcal
                ? `  Average logged day ${r.avgKcal} kcal each — confidence ${r.kcalConfidence}.`
                : "",
              r.newThings.length
                ? `  New this year: ${r.newThings.map((n) => n.name).join(", ")}`
                : "",
            );
          }
          return text(out.filter((l) => l !== "").join("\n"));
        }),
    },
  ];
}
