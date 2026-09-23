/**
 * Reading the kitchen: status, the inventory, and the evidence behind what the
 * kitchen is unsure of.
 */

import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import { eaterCount, getAccount } from "../src/accounts.ts";
import { VERDICTS, applyVerdicts } from "../src/assess.ts";
import { describeEvidence, evidence } from "../src/evidence.ts";
import { readFollowups } from "../src/followups.ts";
import { expiring, learnedSchedule, shoppingList } from "../src/insights.ts";
import { amount, corruptLines, daysLeft, fold, live, match, openPlans } from "../src/store.ts";
import { CATEGORIES, LOCATIONS } from "../src/types.ts";
import { table } from "../src/util.ts";
import { Acct, rerender, text, withAccount } from "./shared.ts";

/** Items the kitchen doubts are still there, most doubtful first. */
const uncertain = (id: string) =>
  evidence(id).filter((e) => e.estimate === "unsure" || e.estimate === "doubtful");

export function readTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "kitchen_status",
      description:
        "Whose kitchen this is, what is about to expire, what ran out, and any meal " +
        "planned but not yet confirmed. Call this FIRST for any food, cooking, recipe, " +
        "grocery or meal-planning question — it is the cheapest way to stop claiming " +
        "the house has something it does not.",
      inputSchema: z.object({ account: Acct }),
      handler: ({ account }) =>
        withAccount(ctx, account, (id) => {
          const acct = getAccount(id)!;
          const items = fold(id);
          const stock = live(id, items);
          const soon = expiring(id, 5);
          const out = shoppingList(id);
          const plans = Object.values(openPlans(id));
          const sched = learnedSchedule(id);
          const damaged = corruptLines.get(id) ?? [];
          const lines = [
            `Household: ${acct.name} (${id}), ${eaterCount(acct)} eater(s), ${acct.members.length} linked chat(s)`,
            `${stock.length} items in stock.`,
            // The fold skips unparseable lines so one torn write cannot take the
            // kitchen offline; say so, or a damaged ledger reads as a healthy one.
            ...(damaged.length
              ? [
                  `WARNING: ${damaged.length} unreadable line(s) in this ledger (line ${damaged.join(", ")}) were skipped. Everything below is computed without them. Tell a human.`,
                ]
              : []),
            "",
            soon.length ? "On a clock:" : "Nothing expiring in the next 5 days.",
            ...soon.map(
              (i) =>
                `  ${i.days < 0 ? `EXPIRED ${-i.days}d` : `${i.days}d`}  ${i.name} (${amount(i)}, ${i.loc})`,
            ),
            "",
            out.length
              ? `Out or low: ${out.map((i) => i.name).join(", ")}`
              : "Nothing flagged out or low.",
            // "Out" is not "needs buying"; point at the tool that answers the latter.
            "For what to actually BUY, call kitchen_shopping — some of the above is " +
              "deliberately not on the list, and the list has things this line does not.",
          ];
          const doubtful = uncertain(id);
          if (doubtful.length) {
            const names = doubtful.slice(0, 12).map((e) => e.item.name);
            const more = doubtful.length > 12 ? ` and ${doubtful.length - 12} more` : "";
            lines.push(
              "",
              `Might be gone or low, so ask before a dish depends on them: ${names.join(", ")}${more}. kitchen_inventory action:"review" has the evidence.`,
            );
          }
          if (plans.length) {
            lines.push("", "Planned, awaiting confirmation:");
            for (const p of plans)
              lines.push(`  ${p.id}  ${p.meal}${p.when ? ` (${p.when})` : ""}`);
          }
          if (sched.dinnerHour !== null) {
            lines.push("", `Usual dinner around ${sched.dinnerHour}:00; ${sched.basis}.`);
          }
          return text(lines.join("\n"));
        }),
    },

    {
      name: "kitchen_list",
      description:
        "The household's inventory, optionally filtered or searched. Use `query` to ask " +
        "whether one specific thing is in the house — it answers strictly, so a near " +
        "miss is reported as a near miss rather than a yes. 'Not tracked' means nobody " +
        "logged it, which is NOT the same as the house not having it.",
      inputSchema: z.object({
        account: Acct,
        query: z.string().optional().describe("Ask about one item, e.g. 'cream cheese'."),
        location: z.enum(LOCATIONS).optional(),
        category: z.enum(CATEGORIES).optional(),
      }),
      handler: ({ account, query, location, category }) =>
        withAccount(ctx, account, (id) => {
          const items = fold(id);
          if (query) {
            const m = match(query, items);
            const hits = m.exact.filter((h) => !h.gone);
            if (hits.length) {
              return text(
                hits
                  .map((h) => {
                    const d = daysLeft(h);
                    return `yes — ${h.name}, ${amount(h)}, in the ${h.loc}${d === null ? "" : `, ${d}d left`}`;
                  })
                  .join("\n"),
              );
            }
            const near = m.near.filter((h) => !h.gone);
            return text(
              near.length
                ? `not tracked — nothing is called "${query}". The ledger does have ` +
                    `${near
                      .slice(0, 4)
                      .map((h) => `"${h.name}"`)
                      .join(", ")}, which is not the same thing.`
                : `not tracked — "${query}" has never been logged. That is not the same as the house not having it. Ask, do not assume.`,
            );
          }
          let rows = live(id, items);
          if (location) rows = rows.filter((i) => i.loc === location);
          if (category) rows = rows.filter((i) => i.cat === category);
          const body = table(
            rows.map((i) => {
              const d = daysLeft(i);
              return [
                i.name,
                amount(i),
                i.cat,
                i.loc,
                d === null ? "" : d < 0 ? `EXPIRED ${-d}d` : `${d}d`,
              ];
            }),
            ["item", "amount", "category", "where", "expires"],
          );
          return text(`${body}\n\n${rows.length} items`);
        }),
    },

    {
      name: "kitchen_inventory",
      description:
        "Reason about what is really in the kitchen. The ledger only hears about groceries, " +
        "so it drifts. `review` lists the items the kitchen is unsure of, each with its " +
        "evidence: when it was bought, meals cooked or suggested with it since, when anyone " +
        "last looked, and how long it keeps where it is stored. `assess` records a verdict " +
        "per item (here, frozen, low, gone). From your own reasoning, low and gone are held " +
        "and raised in the next meal follow-up; with told:true (a person said so) they are " +
        "written at once.",
      inputSchema: z.object({
        account: Acct,
        action: z.enum(["review", "assess"]),
        told: z
          .boolean()
          .optional()
          .describe("assess: true when a person told you, false when you reasoned it."),
        verdicts: z
          .array(
            z.object({
              item: z.string().describe("The item's id or exact name."),
              verdict: z.enum(VERDICTS),
              reason: z.string().optional().describe("A few plain words."),
            }),
          )
          .optional(),
      }),
      handler: (a) =>
        withAccount(ctx, a.account, (id) => {
          if (a.action === "review") {
            const ev = uncertain(id);
            const held = Object.entries(readFollowups(id).suspects);
            const lines = [
              ev.length
                ? `Unsure about ${ev.length} item(s), most doubtful first:`
                : "Nothing in the kitchen looks doubtful.",
              ...ev.map((e) => `  ${e.estimate.padEnd(8)} ${describeEvidence(e)}`),
            ];
            if (held.length) {
              lines.push(
                "",
                "Waiting to ask about in the next follow-up:",
                ...held.map(([k, x]) => `  ${x.name} [${k}]: ${x.verdict}, ${x.reason}`),
              );
            }
            return text(lines.join("\n"));
          }
          if (!a.verdicts?.length) return text("No verdicts to record.", true);
          const res = applyVerdicts(id, a.verdicts, { told: a.told === true });
          const render = res.batch ? rerender(id) : null;
          return text(
            [...res.said, ...res.refused.map((r) => `Not recorded: ${r}.`), render ?? ""]
              .filter(Boolean)
              .join("\n"),
            !res.said.length,
          );
        }),
    },
  ];
}
