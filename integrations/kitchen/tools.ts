/**
 * Kitchen integration — typed tools over the per-household ledger.
 *
 * These replaced a pile of shelled-out `python3 pantry.py ...` calls, which were
 * deleted on 2026-08-17. The difference that mattered was never ergonomics: argv
 * had no schema, so a malformed quantity or a misspelled location failed at the
 * far end of a subprocess, as text, after the write had already been attempted.
 * Here the shape is validated before anything touches an append-only file.
 *
 * The account is resolved once per call from the calling chat session, so no
 * tool takes a household argument in normal use and no tool can span two.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../../src/mcp/context.ts";
import type { ToolDef } from "../../src/mcp/tools/types.ts";
import { kitchenConfig } from "./config.ts";
import {
  NoAccountError,
  createAccount,
  eaterCount,
  getAccount,
  joinAccount,
  leaveAccount,
  listAccounts,
  resolveAccount,
  updateAccount,
} from "./src/accounts.ts";
import { eaters, householdTitle } from "./src/accounts.ts";
import { scanAssets } from "./src/assets.ts";
import { appendTurn, openQuestions, publishThreads, readThread } from "./src/chat.ts";
import {
  type BuiltRecipe,
  getRecipe,
  groupRecipes,
  loadCookbook,
  saveRecipe,
  variantId,
} from "./src/cookbook.ts";
import { STORES, bestBasket, bestDeals, importPrices, loadPrices } from "./src/deals.ts";
import { checkAccount, checkAll, format, summarise } from "./src/doctor.ts";
import {
  expiring,
  intake,
  kcalTarget,
  learnedSchedule,
  meals,
  recap,
  shoppingList,
  spend,
} from "./src/insights.ts";
import { WAIT_MS, syncNote } from "./src/notesync.ts";
import { addTo, emptyTotal } from "./src/nutrition.ts";
import { acceptStock, accountOf, firstStock, provision, state } from "./src/onboard.ts";
import { confirmPlan } from "./src/plans.ts";
import { addNote, loadProfiles, toggleFavorite } from "./src/profile.ts";
import {
  type Verdict,
  answer as answerCheck,
  applySession,
  openSession,
  progress,
  readSessions,
  startSession,
} from "./src/reconcile.ts";
import { markHandled, pending, requestKey } from "./src/requests.ts";
import { setDisposition, skip } from "./src/restock.ts";
import {
  type Dinner,
  MEALS,
  composeText,
  describe,
  dinnersOf,
  nextFire,
  normalize,
  pickFor,
  recipeUrl,
  saveDinners,
} from "./src/schedules.ts";
import { applyKitchenConfig, priceMaxAgeDays } from "./src/settings.ts";
import { readShelves } from "./src/shelfread.ts";
import { settleAfterPurchase, shopping, tripCount } from "./src/shopping.ts";
import { writeSite } from "./src/site.ts";
import {
  amount,
  append,
  corruptLines,
  daysLeft,
  droppedBatches,
  fold,
  isCategory,
  isLocation,
  live,
  match,
  newPlanId,
  nowIso,
  openPlans,
  readLog,
  resolveOne,
  slug,
} from "./src/store.ts";
import { CATEGORIES, LEVELS, LOCATIONS, type Plan, type PlanLine } from "./src/types.ts";
import { table } from "./src/util.ts";

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

/** Every handler funnels through this so a missing household reads the same way. */
async function withAccount<T>(
  ctx: ToolContext,
  explicit: string | undefined,
  fn: (account: string) => Promise<T> | T,
) {
  try {
    return await fn(resolveAccount(explicit, ctx.sessionKey));
  } catch (e) {
    if (e instanceof NoAccountError) return text(e.message, true);
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

const Acct = z
  .string()
  .optional()
  .describe("Household id. Omit in normal use — it resolves from the chat session.");

export function kitchenTools(ctx: ToolContext): ToolDef[] {
  if (!kitchenConfig(ctx.config)?.enabled) return [];
  // `dir` and `price_max_age_days` only mean anything once somebody reads them.
  applyKitchenConfig(ctx.config);
  const tools: ToolDef[] = [];

  // ─── read ────────────────────────────────────────────────────────────────

  tools.push({
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
          // Never let a damaged ledger read as a healthy one. The fold silently
          // skips lines it cannot parse so one bad write does not take the whole
          // kitchen offline, but "silently" would then mean nobody ever finds out.
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
          // Out is not the same as needs buying, and conflating them is what made
          // the shopping list unusable. Say so here so the shorter answer is not
          // mistaken for the shopping answer.
          "For what to actually BUY, call kitchen_shopping — some of the above is " +
            "deliberately not on the list, and the list has things this line does not.",
        ];
        if (plans.length) {
          lines.push("", "Planned, awaiting confirmation:");
          for (const p of plans) lines.push(`  ${p.id}  ${p.meal}${p.when ? ` (${p.when})` : ""}`);
        }
        if (sched.dinnerHour !== null) {
          lines.push("", `Usual dinner around ${sched.dinnerHour}:00; ${sched.basis}.`);
        }
        return text(lines.join("\n"));
      }),
  });

  tools.push({
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
  });

  // ─── write ───────────────────────────────────────────────────────────────

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
    expires: z.string().nullable().optional().describe("YYYY-MM-DD. Only where the clock is real."),
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

  tools.push({
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
      source: z.string().optional().describe("e.g. 'receipt:giant-2026-08-15', 'cooked', 'photo'."),
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
            // use/toss must never resolve loosely: decrementing "wide egg noodles"
            // because someone typed "eggs" is invisible corruption.
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
        // A receipt is the strongest evidence this system ever gets, and it is
        // also the moment the shopping list is most likely to be wrong — because
        // the trip that just happened probably ran off somebody's own list, not
        // this one. Settling here means an ignored list still self-corrects.
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
  });

  tools.push({
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
        // Bare undo means "take back the last thing that still counts". Picking the
        // last non-undo batch regardless of whether it was already retracted made a
        // second undo re-target the same batch and report success while changing
        // nothing — the tool claimed a write it did not make.
        const target =
          batch ?? [...evs].reverse().find((e) => e.op !== "undo" && !already.has(e.batch))?.batch;
        if (!target) {
          return text(
            "Nothing left to undo — every batch in this ledger is already retracted.",
            true,
          );
        }
        // An undo naming a batch that does not exist writes a tombstone for nothing
        // and used to report "Dropped batch X" anyway. A confident lie about a write
        // is worse than an error, because nobody goes back to check.
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
  });

  // ─── planning ────────────────────────────────────────────────────────────

  tools.push({
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
        // A plan line's qty is already expressed in the item's own unit, so pass the
        // stocking unit on both sides rather than leaving the guard half-informed.
        for (const l of lines)
          addTo(totals, l.item, l.qty, items[l.item]?.cat, l.unit, items[l.item]?.unit);
        const plan: Plan = {
          id: newPlanId(),
          meal,
          when: when ?? null,
          lines,
          created: nowIso(),
          kcal: Math.round(totals.kcal),
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
  });

  tools.push({
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
        // Through the shared path, not a third copy of it. This one had drifted
        // already: it never wrote the leftovers a confirmed meal puts in the
        // fridge, so a batch cook confirmed from a chat silently lost its second
        // night while the same meal confirmed from the site kept it.
        const done = confirmPlan(id, plan, p);
        return text(
          `Confirmed "${p.meal}". ${done.items} items came off the shelves${done.yields ? `, ${done.yields} leftover(s) went in the fridge.` : "."}`,
        );
      }),
  });

  // ─── derived ─────────────────────────────────────────────────────────────

  tools.push({
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

        // The raw ledger, newest first. Deliberately NOT part of "all": it is the
        // view you want when something looks wrong and the derived numbers are
        // exactly what you have stopped trusting. Retracted batches are shown and
        // marked rather than hidden, because the reason to read a log is usually to
        // find out what was taken back.
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
              e.qty === null || e.qty === undefined ? "" : `${e.qty}${e.unit ? ` ${e.unit}` : ""}`,
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
  });

  tools.push({
    name: "kitchen_shopping",
    description:
      "The shopping list, split by WHY each line is on it: gaps in a meal that was " +
      "planned, staples that ran out, and lines somebody wrote down. Also returns the " +
      "suggestion tray — things that ran out but have never been confirmed as worth " +
      "rebuying, which are deliberately NOT on the list. Use this rather than reading " +
      "stock yourself: 'what do we need' and 'what is out' are different questions and " +
      "answering the second one as if it were the first is what fills a list with noise. " +
      "Set `answer` to record a decision, or `notes` to push the list into Apple Notes.",
    inputSchema: z.object({
      account: Acct,
      answer: z
        .object({
          item: z.string().describe("Ledger slug the decision is about."),
          as: z
            .enum(["always", "never", "skip"])
            .describe(
              "always = keep it stocked and list it whenever it runs out. " +
                "never = a one-off, stop suggesting it. skip = not this trip only.",
            ),
        })
        .optional(),
      notes: z.boolean().optional().describe("Push the current list into Apple Notes."),
      share: z
        .boolean()
        .optional()
        .describe(
          "Invite everyone in the household to the note so it is one shared list on all " +
            "their phones. Writes the note first if it does not exist yet, then invites only " +
            "the people not already on it, so this is safe to call repeatedly.",
        ),
      shareWith: z
        .array(z.string())
        .optional()
        .describe(
          "Extra phone numbers or email addresses to invite, on top of the household. " +
            "Each must be an Apple Account or the invite will not stick.",
        ),
      noteTitle: z
        .string()
        .optional()
        .describe(
          "Name the Apple Note the list lives in, or adopt one that already exists by " +
            "title. Saved on the household; pass once.",
        ),
    }),
    handler: async ({ account, answer, notes, share, shareWith, noteTitle: wanted }) =>
      withAccount(ctx, account, async (id) => {
        const said: string[] = [];
        if (wanted?.trim()) {
          updateAccount(id, { note_list: wanted.trim() });
          said.push(
            `The list will be written into the note called "${wanted.trim()}" from now on.`,
          );
        }
        if (answer) {
          if (answer.as === "skip") skip(id, [answer.item], tripCount(id));
          else setDisposition(id, [answer.item], answer.as, "asked in chat");
          said.push(
            `Recorded: ${answer.item} is ${
              answer.as === "always"
                ? "kept stocked from now on"
                : answer.as === "never"
                  ? "a one-off and will not be suggested again"
                  : "off this trip's list"
            }.`,
          );
        }
        // One operation, not two. Writing the list and inviting people used to be
        // separate calls that each opened the note, which was slow and could leave
        // a note written but unshared. `syncNote` does both inside one session and
        // reads the note first, so ticks made in a shop survive the rewrite.
        if (notes || share) {
          // Waits for the background pass rather than racing it. Two processes
          // driving the same note is not a slow sync, it is a mangled note.
          const r = await syncNote(id, { share, shareWith, wait: WAIT_MS });
          if (!r.ok) {
            said.push(`Apple Notes failed: ${r.error}`);
          } else {
            said.push(
              `${
                (r.wrote
                  ? `Apple Notes: wrote ${r.lines} line(s) to "${r.title}" as tappable checkboxes`
                  : `Apple Notes: "${r.title}" was already current (${r.lines} line(s))`) +
                (r.ticked.length ? `. Already ticked off: ${r.ticked.join(", ")}` : "")
              }.`,
            );
            if (r.adopted.length) {
              said.push(`Picked up off the note and put on the list: ${r.adopted.join(", ")}.`);
            }
            if (r.invited.length) said.push(`Invited ${r.invited.join(", ")}.`);
            if (share && !r.invited.length)
              said.push("Everyone in the household was already on it.");
            if (r.link) said.push(`The link is ${r.link}`);
          }
        }

        const s = shopping(id);
        const lines = s.groups.length
          ? s.groups
              .map((g) =>
                [
                  `${g.title}:`,
                  ...g.lines.map(
                    (l) =>
                      `  ${l.name}${l.amount ? ` (${l.amount})` : ""} — ${l.why}${
                        l.bought !== null && l.bought !== undefined && l.bought <= 2
                          ? `, but bought ${l.bought === 0 ? "today" : `${l.bought}d ago`}`
                          : ""
                      }`,
                  ),
                ].join("\n"),
              )
              .join("\n\n")
          : "The list is empty. Nothing is out and nothing is planned.";
        const tray = s.suggestions.length
          ? `\n\nNot on the list, never asked about:\n${s.suggestions
              .map(
                (x) =>
                  `  ${x.name} — ${x.why}${x.unlocks.length ? ` (${x.unlocks.slice(0, 3).join(", ")})` : ""}`,
              )
              .join(
                "\n",
              )}\nAsk before adding any of these. Record the answer with \`answer\` so it is never asked twice.`
          : "";
        const kept = s.held.length
          ? `\n\nKept off deliberately: ${s.held.map((h) => `${h.name} (${h.why})`).join(", ")}.`
          : "";
        return text([said.join("\n"), lines + tray + kept].filter(Boolean).join("\n\n"));
      }),
  });

  tools.push({
    name: "kitchen_deals",
    description:
      "The shopping list, built automatically from what ran out or went low, priced " +
      "against imported Aldi/Giant/Walmart/Target data. Reports the age of every price " +
      "— a grocery price nobody refreshed is not a deal. If prices are missing or stale, " +
      "go fetch current ones with the browser and load them via kitchen_prices_import.",
    inputSchema: z.object({
      account: Acct,
      extra: z.array(z.string()).optional().describe("Items to price beyond what is flagged."),
      maxAgeDays: z.number().optional(),
    }),
    handler: ({ account, extra, maxAgeDays }) =>
      withAccount(ctx, account, (id) => {
        const acct = getAccount(id)!;
        const items = fold(id);
        // Priced against the real list rather than a second derivation of it.
        // These used to disagree: the deals table costed everything the ledger
        // called out or low, including things the list itself had deliberately
        // held back, so the cheapest basket was for a trip nobody was taking.
        const wanted = shopping(id)
          .lines.filter((l) => l.item)
          .map((l) => ({ id: l.item!, name: l.name }));
        for (const e of extra ?? []) {
          const hit = match(e, items).exact[0];
          wanted.push({ id: hit?.id ?? slug(e), name: hit?.name ?? e });
        }
        if (!wanted.length)
          return text("Nothing is flagged out or low, and no extras were passed.");
        const maxAge = maxAgeDays ?? priceMaxAgeDays();
        const { deals, staleness } = bestDeals(wanted, {
          preferred: acct.stores,
          maxAgeDays: maxAge,
        });
        const priced = deals.filter((d) => d.best);
        const lines = [
          table(
            deals.map((d) => [
              d.name,
              d.best ? `$${d.best.price.toFixed(2)}${d.best.sale ? " SALE" : ""}` : "-",
              d.best ? d.best.store : (d.note ?? "no price"),
              d.saves ? `saves $${d.saves.toFixed(2)}` : "",
              d.ageDays === null ? "" : `${d.ageDays}d old`,
            ]),
            ["need", "best", "store", "vs worst", "price age"],
          ),
        ];
        if (!priced.length) {
          lines.push(
            "",
            `No usable prices on file${staleness.rows ? ` (${staleness.rows} rows, all older than ${maxAge}d)` : ""}.`,
            `Pull current prices for these from aldi.us, giantfoodstores.com, walmart.com and target.com,`,
            `then load them with kitchen_prices_import. Do NOT quote a price you did not just fetch.`,
          );
        } else {
          const baskets = bestBasket(wanted, maxAge);
          lines.push(
            "",
            "One-trip comparison (people do not drive to four stores):",
            table(
              baskets.map((b) => [
                b.store,
                `${b.covers}/${wanted.length}`,
                `$${b.total.toFixed(2)}`,
                b.missing.slice(0, 3).join(", "),
              ]),
              ["store", "covers", "basket", "still need"],
            ),
          );
        }
        return text(lines.join("\n"));
      }),
  });

  tools.push({
    name: "kitchen_prices_import",
    description:
      "Load store prices you have just fetched. Acquisition is deliberately yours — a " +
      "scraper in here would silently go empty when a retailer changes their markup, " +
      "and a stale price shown as current is worse than no price. Only import what you " +
      "actually just read off a page; never estimate.",
    inputSchema: z.object({
      rows: z
        .array(
          z.object({
            item: z.string().describe("Ledger item name it prices, e.g. 'cream cheese'."),
            store: z.enum(STORES),
            price: z.number().positive(),
            size: z
              .string()
              .optional()
              .describe("e.g. '8 oz', 'dozen' — enables fair unit compare."),
            sale: z.boolean().optional(),
            saleEnds: z.string().optional().describe("YYYY-MM-DD"),
            source: z.string().optional().describe("URL or 'weekly circular'."),
          }),
        )
        .min(1),
    }),
    handler: ({ rows }) => {
      const r = importPrices(rows);
      const book = loadPrices();
      return text(
        `Imported ${r.added} new and refreshed ${r.replaced} price(s) for ` +
          `${r.stores.join(", ")}. Price book now holds ${book.rows.length} rows.`,
      );
    },
  });

  // ─── accounts and site ───────────────────────────────────────────────────

  tools.push({
    name: "kitchen_accounts",
    description:
      "Manage households: see which one this chat belongs to, create one, add or remove " +
      "people, and set preferences (weekly budget, preferred stores, diet target and " +
      "restrictions, meal times). Every preference is optional — anything unset is " +
      "derived from logged history instead. A session with no household is a question " +
      "for a human, never a guess. `check` is the one to reach for when something " +
      '"just is not working": it reports what is broken, what is merely absent, and ' +
      "what is fine, because every feature here degrades quietly and a site nobody can " +
      "open looks identical to a household with nothing to say.",
    inputSchema: z.object({
      action: z.enum(["list", "whoami", "create", "join", "leave", "settings", "check"]),
      account: Acct,
      name: z.string().optional(),
      note: z.string().optional(),
      member: z
        .string()
        .optional()
        .describe("Session key, e.g. 'imessage:dm:+15551234567'. Omit to mean this chat."),
      budget: z.number().optional().describe("Weekly grocery target in dollars."),
      stores: z.array(z.enum(STORES)).optional(),
      kcalTarget: z.number().nullable().optional(),
      dietStyle: z.string().nullable().optional(),
      avoid: z.array(z.string()).optional().describe("e.g. ['pork','shellfish']"),
      dinner: z.string().optional().describe("'HH:MM' — overrides the learned time."),
      prepDays: z.array(z.string()).optional(),
    }),
    handler: (a) => {
      const me = ctx.sessionKey;
      try {
        if (a.action === "list") {
          const rows = listAccounts().map((x) => [
            x.id,
            x.name,
            `${x.members.length} member(s)`,
            `${readLog(x.id).length} events`,
            x.members.includes(me) ? "<- this chat" : "",
          ]);
          return text(
            rows.length
              ? table(rows, ["id", "name", "people", "log", ""])
              : "No households registered yet.",
          );
        }
        if (a.action === "check") {
          // Every household when none is named, because the usual reason to ask
          // is that somebody else's is broken and nobody has noticed.
          const reports = a.account ? [checkAccount(resolveAccount(a.account, me))] : checkAll();
          if (!reports.length) return text("No households registered yet.");
          return text(
            `${reports.map((r) => `${summarise(r)}\n${format(r)}`).join("\n\n")}\n\n"absent" is a working state, not a fault. Only BROKEN lines need doing something about.`,
          );
        }
        if (a.action === "whoami") {
          let id: string | null = null;
          try {
            id = resolveAccount(a.account, me);
          } catch {
            /* unresolved is the answer */
          }
          const acct = id ? getAccount(id) : null;
          if (!acct)
            return text(
              `This chat (${me}) belongs to no household yet. Ask whose kitchen it is, then create or join one.`,
            );
          const s = learnedSchedule(id!);
          return text(
            [
              `Chat ${me}`,
              `Household ${id} — ${acct.name}`,
              `Members: ${acct.members.join(", ")}`,
              `Budget: ${acct.budget ? `$${acct.budget}/week` : "not set (spend is still tracked)"}`,
              `Stores: ${acct.stores?.join(", ") || "no preference set"}`,
              `Diet: ${acct.diet?.style || "no style set"}${acct.diet?.avoid?.length ? `, avoiding ${acct.diet.avoid.join(", ")}` : ""}`,
              `Dinner: ${acct.schedule?.dinner || (s.dinnerHour !== null ? `~${s.dinnerHour}:00 (learned)` : "not enough history yet")}`,
              `Site: ${acct.site?.url || "not published yet"}`,
            ].join("\n"),
          );
        }
        if (a.action === "create") {
          if (!a.account)
            return text("Pass `account` as the new household id (lowercase, dashes).", true);
          // `me` can be absent outside a chat session. Defaulting to it blindly
          // wrote a null into members, which is a principal nobody can ever be
          // and a household nobody can ever reach.
          const owner = a.member ?? me;
          if (!owner) {
            return text(
              "No chat session to attach, so pass `member` explicitly with the " +
                "session key that should own this household.",
              true,
            );
          }
          const acct = createAccount(a.account, {
            name: a.name,
            note: a.note,
            members: [owner],
          });
          return text(
            `Created "${a.account}" (${acct.name}) with ${acct.members.length} member(s). Its ledger starts empty — log groceries or a meal and every derived feature fills in by itself.`,
          );
        }
        if (a.action === "join" || a.action === "leave") {
          if (!a.account) return text("Pass `account`.", true);
          const who = a.member ?? me;
          const acct =
            a.action === "join" ? joinAccount(a.account, who) : leaveAccount(a.account, who);
          return text(
            `${who} ${a.action === "join" ? "joined" : "left"} ${a.account}. ` +
              `Now ${acct.members.length} member(s).`,
          );
        }
        const id = resolveAccount(a.account, me);
        const patch: Record<string, unknown> = {};
        if (a.name) patch.name = a.name;
        if (a.note) patch.note = a.note;
        if (a.budget !== undefined) patch.budget = a.budget;
        if (a.stores) patch.stores = a.stores;
        if (a.kcalTarget !== undefined || a.dietStyle !== undefined || a.avoid) {
          patch.diet = {
            ...(a.kcalTarget !== undefined ? { kcal_target: a.kcalTarget } : {}),
            ...(a.dietStyle !== undefined ? { style: a.dietStyle } : {}),
            ...(a.avoid ? { avoid: a.avoid } : {}),
          };
        }
        if (a.dinner || a.prepDays) {
          patch.schedule = {
            ...(a.dinner ? { dinner: a.dinner } : {}),
            ...(a.prepDays ? { prep_days: a.prepDays } : {}),
          };
        }
        const acct = updateAccount(id, patch as never);
        return text(
          `Updated ${id}. Budget ${acct.budget ?? "unset"}, stores ` +
            `${acct.stores?.join("/") ?? "unset"}, diet ${acct.diet?.style ?? "unset"}.`,
        );
      } catch (e) {
        if (e instanceof NoAccountError) return text(e.message, true);
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  });

  tools.push({
    name: "kitchen_site",
    description:
      "Render this household's own website — inventory, what to use first, eating, " +
      "shopping and deals, their cooking rhythm, and the recap — as one self-contained " +
      "page. Re-render into the SAME artifact directory to update a live link without " +
      "minting a new URL. One site per household; never point two at one directory.",
    inputSchema: z.object({
      account: Acct,
      dir: z
        .string()
        .optional()
        .describe(
          "Artifact directory. Omit to use the household's saved one, or a new dir under this sandbox.",
        ),
      url: z.string().optional().describe("Record the public URL once it is shared."),
    }),
    handler: ({ account, dir, url }) =>
      withAccount(ctx, account, (id) => {
        const acct = getAccount(id)!;
        const target = dir ?? acct.site?.artifact ?? join(ctx.sandboxPath, `kitchen-site-${id}`);
        mkdirSync(target, { recursive: true });
        const path = join(target, "index.html");
        // Photography is scanned from the output directory rather than assumed, so
        // the page only ever emits an <img> for a file that is actually sitting
        // next to it. A grid of broken-image icons reads as a broken site.
        const assets = scanAssets(target);
        // One call writes the hub, a page per written recipe, and the chat threads
        // the hub polls, so no caller can produce a hub linking to pages nobody
        // wrote. Threads are republished every render, so a freshly-shared
        // directory is never missing a conversation that already exists.
        const { pages } = writeSite(id, acct, target);
        if (target !== acct.site?.artifact || url) {
          updateAccount(id, {
            site: { artifact: target, url: url ?? acct.site?.url ?? null },
          } as never);
        }
        return text(
          `Rendered "${householdTitle(acct)}" to ${path}.\nPhotos found: ${assets.items.size} item, ${assets.meals.size} meal. Recipe pages: ${pages}.\nShare that directory to publish it; re-run this tool against the same dir to refresh it in place.`,
        );
      }),
  });

  // ── the cookbook: long-form recipes, written once and kept ─────────────────

  const IngredientS = z.object({
    name: z.string(),
    amount: z.string().describe('Free text, e.g. "1 medium, diced" or "a splash".'),
    item: z.string().nullish().describe("Ledger slug when this maps to tracked stock."),
    note: z.string().nullish(),
  });

  const StepS = z.object({
    n: z.number().int().positive(),
    title: z.string().describe('The imperative, e.g. "Sear the chops".'),
    /**
     * NOT the instructions. The page renders this as a lede paragraph ABOVE the
     * numbered actions, so every sentence here is a sentence between the cook
     * and what they are meant to do. Written long, it is the thing people say
     * they stopped reading.
     */
    body: z
      .string()
      .describe(
        "One sentence, two at the very most, on WHY this step matters or the one " +
          "thing that goes wrong. It renders as a short lede ABOVE the numbered " +
          "actions, so a paragraph here buries the instructions. Every how-to " +
          "detail belongs in `parts` instead. Prefer a bare sentence over padding.",
      ),
    minutes: z.number().nullish().describe("Set when the step is timed."),
    /**
     * What this step puts in the pan, with the amount FOR THIS STEP.
     *
     * This field did not exist until 2026-08-17, so every recipe written before
     * then has empty step ingredients and the page falls back to the whole-dish
     * amount — which is a shopping quantity, often a sentence, and wrong for the
     * step. "2 teaspoons on the shrimp, plus a pinch for the corn" appeared on
     * the step that blisters the corn, where the answer is "a pinch".
     */
    uses: z
      .array(
        z.object({
          ingredient: z.string().describe("Must match an ingredient name exactly."),
          amount: z.string().nullish().describe('How much at THIS step, e.g. "a pinch".'),
        }),
      )
      .nullish()
      .describe("Ingredients this step uses, with per-step amounts."),
    /**
     * The rest of what the page actually renders, and what this schema was
     * silently unable to carry. `parts` is the step as single actions, which is
     * the whole readability argument for the recipe page; `watch` is the most
     * looked-at sentence in any step. A recipe saved through this tool before
     * 2026-08-17 arrived as a bare paragraph no matter how it was written.
     */
    parts: z
      .array(z.string())
      .nullish()
      .describe(
        "The step as single actions, in order, and THIS is where the detail " +
          "goes. One action each, written out in full: the amount, the pan, the " +
          "heat, the time, what to do with your hands. Being verbose here is " +
          "correct and being verbose in `body` is not. Never put two things " +
          'happening at once into one part, and never write "while that cooks, ' +
          'prep the..." — if something has to be ready first, it is an earlier ' +
          "step, not an aside.",
      ),
    watch: z
      .string()
      .nullish()
      .describe("How to tell it is done, in what you can see, hear or smell."),
    techniques: z
      .array(z.string())
      .nullish()
      .describe("Technique ids this step demonstrates. The page infers most."),
  });

  tools.push({
    name: "kitchen_recipe_get",
    description:
      "Read a recipe that has already been written out, if it exists. ALWAYS call this " +
      "before writing one: a recipe that has been built once is kept forever, and " +
      "rebuilding it costs a model call for an answer that is already on disk.",
    inputSchema: z.object({
      account: Acct,
      recipe: z
        .string()
        .describe("Recipe id, e.g. 'chicken-rice' or a variant 'chicken-rice--no-cream'."),
    }),
    handler: ({ account, recipe }) =>
      withAccount(ctx, account, (id) => {
        const r = getRecipe(id, recipe);
        if (!r) {
          return text(
            `No written recipe for "${recipe}" yet. Write it, then save it with kitchen_recipe_save so the next request is free.`,
          );
        }
        return text(JSON.stringify(r, null, 2));
      }),
  });

  tools.push({
    name: "kitchen_recipe_save",
    description:
      "Persist a written recipe so it never has to be written again. Pass `base` to " +
      "record this as a VARIANT of another dish (built because the house was missing " +
      "something) — variants group under their original on the site rather than " +
      "cluttering the catalog as unrelated dinners.",
    inputSchema: z.object({
      account: Acct,
      id: z.string().nullish().describe("Omit for a variant; it is derived from base + name."),
      base: z.string().nullish().describe("Parent recipe id when this is a variant."),
      name: z.string(),
      desc: z.string(),
      minutes: z.number().int().positive(),
      serves: z.number().int().positive().default(2),
      cat: z.string().default("dinner"),
      needs: z
        .array(z.tuple([z.string(), z.number().nullable()]))
        .describe("[ledger slug, qty|null] — what it consumes, for the cookability check."),
      ingredients: z.array(IngredientS),
      steps: z
        .array(StepS)
        .describe(
          "In the exact order a person does them, start to finish, with no " +
            "juggling. All the knife work and measuring comes before anything " +
            "goes in a pan. One step is one coherent task on one component — " +
            "never 'cook the chicken, then prep the veggies' inside a single " +
            "step, and never send the cook back to a board once a pan is hot. " +
            "If a step needs something ready, an earlier step made it ready.",
        ),
      variant_reason: z
        .string()
        .nullish()
        .describe('Why this version exists, e.g. "no cream in the house, built on milk".'),
    }),
    handler: (a) =>
      withAccount(ctx, a.account, (id) => {
        const rid = a.id ?? (a.base ? variantId(a.base, a.name) : slug(a.name));
        const saved = saveRecipe(id, {
          id: rid,
          base: a.base ?? null,
          name: a.name,
          desc: a.desc,
          minutes: a.minutes,
          serves: a.serves,
          cat: a.cat,
          needs: a.needs as BuiltRecipe["needs"],
          ingredients: (a.ingredients as z.infer<typeof IngredientS>[]).map((i) => ({
            name: i.name,
            amount: i.amount,
            item: i.item ?? null,
            note: i.note ?? null,
          })),
          // Spelled out field by field, so anything added to the schema and not
          // added here is silently dropped. That is how `uses` went missing: the
          // writer could not send it and the page had to guess. Keep this list in
          // step with StepS.
          steps: (a.steps as z.infer<typeof StepS>[]).map((s) => ({
            n: s.n,
            title: s.title,
            body: s.body,
            minutes: s.minutes ?? null,
            uses: (s.uses ?? []).map((u) => ({
              ingredient: u.ingredient,
              amount: u.amount ?? null,
            })),
            parts: s.parts ?? [],
            watch: s.watch ?? null,
            techniques: s.techniques ?? [],
          })),
          variantReason: a.variant_reason ?? null,
          builtBy: ctx.sessionKey ?? null,
        });
        // Named rather than counted silently. A step with no `uses` still renders,
        // by inferring the ingredients from its own words and falling back to the
        // whole-dish amount, so nothing looks broken and the page quietly tells
        // somebody to put two teaspoons in where it wanted a pinch.
        const bare = saved.steps.filter((s) => !s.uses?.length).map((s) => s.n);
        // The three ways a step reads badly on the page, named at the moment they
        // are cheap to fix. A recipe that trips these still saves and still
        // renders, which is exactly why nobody noticed them drifting back in.
        const wordy = saved.steps
          .filter((s) => s.parts?.length && s.body && s.body.length > 220)
          .map((s) => s.n);
        const unsplit = saved.steps.filter((s) => !s.parts?.length).map((s) => s.n);
        // "while it is still hot" is a condition, not a second task, and a lint that
        // cries wolf on those gets ignored. Only flag a real unattended-pan cue: a verb
        // right after the subject ("while that cooks") or an -ing after is/are ("while
        // the rice is simmering"). "is warm" and "is still hot" are adjectives and pass.
        const UNATTENDED =
          "cooks?|simmers?|boils?|bakes?|rests?|browns?|heats?|warms?" +
          "|reduces?|chills?|roasts?|fries|fry";
        const UNATTENDING =
          "cooking|simmering|boiling|baking|resting|browning|heating" +
          "|warming|reducing|chilling|roasting|frying";
        const CONCURRENT = new RegExp(
          String.raw`\b(?:while|as)\s+(?:that|it|they|those|the\s+\w+)\s+` +
            String.raw`(?:(?:${UNATTENDED})\b|(?:is|are)\s+(?:${UNATTENDING})\b)` +
            String.raw`|\bmeanwhile\b|\bin the meantime\b|\bat the same time\b`,
          "i",
        );
        const juggling = saved.steps
          .filter((s) => (s.parts ?? []).some((x) => CONCURRENT.test(x)) || CONCURRENT.test(s.body))
          .map((s) => s.n);
        const list = (ns: number[]) => `step${ns.length === 1 ? "" : "s"} ${ns.join(", ")}`;
        return text(
          `Saved "${saved.name}" as ${saved.id}${saved.base ? ` (variant of ${saved.base})` : ""}. Re-render the site to publish it.${
            bare.length
              ? `\n\nNOT FINISHED: ${list(bare)} came back with no ingredients of their own, so the page will infer them and show the SHOPPING amount instead of the amount for that step. Save again with a "uses" on each.`
              : ""
          }${
            unsplit.length
              ? `\n\nNOT FINISHED: ${list(unsplit)} sent no "parts", so the page has to guess where the actions are by splitting the paragraph on full stops. Save again with one action per part.`
              : ""
          }${
            wordy.length
              ? `\n\nTOO WORDY: ${list(wordy)} put a long paragraph in "body", which renders ABOVE the numbered actions and pushes them off the screen. Cut it to a sentence and move the detail down into "parts".`
              : ""
          }${
            juggling.length
              ? `\n\nCONCURRENCY: ${list(juggling)} asks the cook to do two things at once ("while that cooks", "meanwhile"). Split it so each step is one task and anything that must be ready first happens in an earlier step.`
              : ""
          }`,
        );
      }),
  });

  tools.push({
    name: "kitchen_cookbook",
    description:
      "Every recipe written for this household, grouped as one dish per entry with its " +
      "variants nested underneath.",
    inputSchema: z.object({ account: Acct }),
    handler: ({ account }) =>
      withAccount(ctx, account, (id) => {
        const groups = groupRecipes(loadCookbook(id));
        if (!groups.length) return text("Nothing written out yet.");
        return text(
          groups
            .map((g) => {
              const vs = g.variants
                .map(
                  (v) =>
                    `    variant ${v.id}: ${v.name}${v.variantReason ? ` — ${v.variantReason}` : ""}`,
                )
                .join("\n");
              return `${g.primary.id}: ${g.primary.name} (${g.primary.minutes} min, ${g.primary.steps.length} steps)${vs ? `\n${vs}` : ""}`;
            })
            .join("\n"),
        );
      }),
  });

  // ── standing texts ────────────────────────────────────────────────────────

  tools.push({
    name: "kitchen_schedule",
    description:
      "Standing 'text us what we are having' schedules for a household. Use this when " +
      "somebody asks to be texted dinner at a time, e.g. 'text Sam and me at 4 every " +
      "day with dinner'. The pick and the send happen unattended from this Mac, so once " +
      "it is set nothing needs you again. Times are 24-hour HH:MM local; days are 0=Sunday " +
      "through 6=Saturday and an empty list means every day. Omit `to` to text everyone " +
      "in the household. `preview` shows exactly what would be sent right now without " +
      "sending anything.",
    inputSchema: z.object({
      account: Acct,
      action: z.enum(["list", "set", "remove", "pause", "resume", "preview"]).default("list"),
      id: z
        .string()
        .nullish()
        .describe(
          "Which schedule. Required for remove/pause/resume, " +
            "and for editing an existing one rather than adding another.",
        ),
      at: z.string().nullish().describe("set: 24-hour HH:MM, e.g. '16:00'."),
      days: z
        .array(z.number().min(0).max(6))
        .optional()
        .describe("set: 0=Sunday..6=Saturday. Empty or omitted means every day."),
      to: z
        .array(z.string())
        .optional()
        .describe("set: principals to text. Omit for everyone who eats here. Must be members."),
      meal: z.enum(MEALS).optional().describe("set: which meal. Default dinner."),
      note: z
        .string()
        .nullish()
        .describe("set: a standing steer like 'something quick'. Nudges the pick, never filters."),
    }),
    handler: (a) =>
      withAccount(ctx, a.account, (id) => {
        const acct = getAccount(id)!;
        const list = dinnersOf(acct);
        const show = () =>
          list.length
            ? list
                .map((d) => {
                  const n = nextFire(d);
                  return `${d.id}  ${describe(d, acct)}${
                    d.on
                      ? `\n    next: ${n ? n.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" }) : "no day left"}`
                      : ""
                  }${d.last ? `\n    last sent: ${d.last}` : "\n    never sent yet"}`;
                })
                .join("\n")
            : "No standing texts set for this household.";

        if (a.action === "list") return text(show());

        if (a.action === "preview") {
          const meal = a.meal ?? "dinner";
          const pick = pickFor(id, acct, meal);
          const url = pick?.written ? recipeUrl(acct, pick.recipe.id) : null;
          const outNow = shoppingList(id).length;
          const body = composeText(
            pick,
            {
              id: "preview",
              at: a.at ?? "18:00",
              days: a.days ?? [],
              to: a.to ?? [],
              meal,
              on: true,
              created: new Date().toISOString(),
            },
            acct,
            url,
            outNow,
          );
          return text(
            `Nothing was sent. This is what a ${meal} text would say right now:\n\n${body}${
              pick && !pick.written
                ? `\n\n(No written page for "${pick.recipe.name}" yet, so firing would also ask for one and the page would follow.)`
                : ""
            }`,
          );
        }

        if (a.action === "remove" || a.action === "pause" || a.action === "resume") {
          if (!a.id) return text('Which one? Call action:"list" for the ids.', true);
          const found = list.find((d) => d.id === a.id);
          if (!found) return text(`No schedule ${a.id} on this household.`, true);
          if (a.action === "remove") {
            saveDinners(
              id,
              list.filter((d) => d.id !== a.id),
            );
            return text(`Removed ${a.id} (${describe(found, acct)}).`);
          }
          const on = a.action === "resume";
          saveDinners(
            id,
            list.map((d) => (d.id === a.id ? { ...d, on } : d)),
          );
          return text(
            `${a.id} is ${on ? "back on" : "paused"}. ${describe({ ...found, on }, acct)}`,
          );
        }

        if (!a.at) return text('A schedule needs a time, e.g. at:"16:00".', true);
        const was = a.id ? list.find((d) => d.id === a.id) : undefined;
        if (a.id && !was) return text(`No schedule ${a.id} to edit.`, true);
        let d: Dinner;
        try {
          d = normalize(
            {
              id: a.id ?? undefined,
              at: a.at,
              days: a.days ?? [],
              to: a.to ?? [],
              meal: a.meal ?? "dinner",
              note: a.note ?? null,
              on: true,
              created: was?.created,
              fired: was?.fired ?? null,
              last: was?.last ?? null,
            },
            acct,
          );
        } catch (e) {
          return text((e as Error).message, true);
        }
        saveDinners(id, [...list.filter((x) => x.id !== d.id), d]);
        const n = nextFire(d);
        return text(
          `Set. ${d.id}: ${describe(d, acct)}.\nNext fire: ${n ? n.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" }) : "no day left this week"}.\nThis sends itself from this Mac, so tell them it is live and needs nothing else.`,
        );
      }),
  });

  tools.push({
    name: "kitchen_requests",
    description:
      "Taps on the website waiting for an answer — someone pressed Make, Make a " +
      "variant, or Write one for the clock. Returns them oldest first. Pass `handled` " +
      "with the timestamps you have actually served to clear them; a request served " +
      "twice means a person gets the same recipe texted to them twice.\n" +
      "A `compose` request has NO recipe id and is not a lookup: nothing in the " +
      "catalog was the right dinner. Read kitchen_status for what is on a clock, " +
      "write a dish around that food and any steer in `text`, run kitchen_plan so it " +
      "is checked against real stock, save it with kitchen_recipe_save so the catalog " +
      "gains a dinner that actually happened, then text the page to `users`.",
    inputSchema: z.object({
      account: Acct,
      handled: z
        .array(z.string())
        .optional()
        .describe("The `key` values printed for each request. Only pass these AFTER texting."),
    }),
    handler: ({ account, handled: done }) =>
      withAccount(ctx, account, (id) => {
        const acct = getAccount(id)!;
        const dir = acct.site?.artifact;
        if (!dir) return text("No site directory recorded for this household yet.", true);
        if (done?.length) {
          markHandled(id, done);
          return text(`Marked ${done.length} request(s) served.`);
        }
        const reqs = pending(id, dir);
        if (!reqs.length) return text("Nothing waiting.");
        return text(
          reqs
            .map((r) => {
              const who = r.profile ? `  by: ${r.profile}` : "";
              const head = `key: ${requestKey(r)}\n  ${r.kind}${who}`;
              switch (r.kind) {
                case "chat":
                  return `${head}\n  page: ${r.page ?? "?"}${r.subject ? ` (looking at "${r.subject}")` : ""}\n  asked: ${r.text ?? ""}`;
                case "note":
                  return `${head}\n  meal: ${r.name ?? r.recipe}\n  wrote: ${r.text ?? ""}`;
                case "favorite":
                  return `${head}  ${r.on ? "starred" : "unstarred"} ${r.recipe}`;
                case "shopped":
                  return `${head}\n  picked up: ${(r.items ?? []).join(", ") || "(nothing ticked)"}`;
                case "plan":
                  return `${head}\n  plan ${r.plan} "${r.name ?? ""}" -> ${r.note}`;
                default:
                  return `${head}  ${r.recipe} "${r.name ?? ""}"${
                    r.users?.length
                      ? `\n  text: ${r.users.join(", ")}`
                      : "\n  text: (single-person household)"
                  }${r.missing?.length ? `\n  missing: ${r.missing.join(", ")}` : ""}`;
              }
            })
            .join("\n\n"),
        );
      }),
  });

  // ── on-page chat ──────────────────────────────────────────────────────────

  tools.push({
    name: "kitchen_chat",
    description:
      "The conversation happening ON the website. Read a person's thread, or answer " +
      "them. An answer is published to a file the page polls, so it appears in their " +
      "browser without a text message. Use this for questions asked from the site; " +
      "message_contact is still the right tool for anything they should get as a text.",
    inputSchema: z.object({
      account: Acct,
      profile: z
        .string()
        .nullish()
        .describe("Whose thread. Omit to list every thread with an unanswered question."),
      reply: z.string().nullish().describe("Your answer. Omit to just read."),
      log_question: z
        .string()
        .nullish()
        .describe("Record what they asked, when it came in via a callback rather than the page."),
      page: z.string().nullish(),
      subject: z.string().nullish(),
    }),
    handler: (a) =>
      withAccount(ctx, a.account, (id) => {
        const acct = getAccount(id)!;
        const people = eaters(acct).map((e) => e.principal);
        const dir = acct.site?.artifact;

        if (!a.profile) {
          const open = openQuestions(id, people);
          if (!open.length) return text("No unanswered questions on the site.");
          return text(
            open
              .map(
                (o) =>
                  `${o.principal}\n  page: ${o.turn.page ?? "?"}${o.turn.subject ? ` (${o.turn.subject})` : ""}\n  asked: ${o.turn.text}`,
              )
              .join("\n\n"),
          );
        }
        if (!people.includes(a.profile)) {
          return text(`"${a.profile}" is not a member of this household.`, true);
        }
        if (a.log_question) {
          appendTurn(id, a.profile, {
            from: "them",
            text: a.log_question,
            page: a.page ?? null,
            subject: a.subject ?? null,
          });
        }
        if (a.reply) {
          appendTurn(id, a.profile, {
            from: "me",
            text: a.reply,
            page: a.page ?? null,
            subject: a.subject ?? null,
          });
        }
        // Republish immediately so the answer is on the page within one poll,
        // rather than waiting for whenever the site is next re-rendered.
        const published = dir ? publishThreads(id, people, dir) : 0;
        const turns = readThread(id, a.profile, 12);
        return text(
          (a.reply ? `Answered. Published to ${published} thread file(s).\n\n` : "") +
            turns.map((t) => `${t.from === "me" ? "me " : "them"}: ${t.text}`).join("\n"),
        );
      }),
  });

  tools.push({
    name: "kitchen_mark",
    description:
      "Apply a favourite or a meal note that came from the site. These are preferences " +
      "rather than ledger events, so they do not touch the append-only log.",
    inputSchema: z.object({
      account: Acct,
      what: z.enum(["favorite", "note"]),
      recipe: z.string().describe("Recipe id, or the slug of a past meal's name."),
      who: z.string().describe("The principal who did it."),
      text: z.string().nullish().describe("Required for a note."),
      rating: z.number().min(1).max(5).nullish(),
    }),
    handler: (a) =>
      withAccount(ctx, a.account, (id) => {
        if (a.what === "favorite") {
          const on = toggleFavorite(id, a.recipe, a.who);
          return text(`${a.recipe} is now ${on ? "starred" : "unstarred"} for ${a.who}.`);
        }
        if (!a.text?.trim()) return text("A note needs text.", true);
        addNote(id, a.recipe, { who: a.who, text: a.text.trim(), rating: a.rating ?? null });
        const all = loadProfiles(id).notes[a.recipe] ?? [];
        return text(`Noted against ${a.recipe}. ${all.length} note(s) on that meal now.`);
      }),
  });

  // ─── the shelf check ──────────────────────────────────────────────────────

  tools.push({
    name: "kitchen_check",
    description:
      "Reconcile the ledger against the actual shelves. Three ways in, one pass: " +
      "`photos` reads pictures of a fridge or cabinet and PROPOSES a diff; `start` " +
      "opens a text-driven pass over the items worth asking about; `answer` records " +
      "verdicts as they come. Nothing reaches the ledger until `apply`. Every verdict " +
      "is stamped with who looked, so a pass Jordan did reads as his. Use this whenever " +
      "somebody sends a kitchen photo or says the counts are off.",
    inputSchema: z.object({
      account: Acct,
      action: z.enum(["photos", "start", "answer", "apply", "status"]),
      by: z
        .string()
        .nullish()
        .describe(
          "Principal of whoever actually looked. Required for photos/start; " +
            "a pass with no name attached is worth much less than one with.",
        ),
      files: z.array(z.string()).optional().describe("photos: absolute paths to the images."),
      where: z.string().nullish().describe("photos: 'fridge', 'the spice drawer', etc."),
      session: z.string().nullish().describe("answer/apply: which pass. Defaults to the open one."),
      answers: z
        .array(
          z.object({
            item: z.string(),
            verdict: z.enum(["have", "gone", "amount"]),
            qty: z.number().nullish(),
          }),
        )
        .optional()
        .describe("answer: one entry per item settled."),
      limit: z.number().optional().describe("start/status: how many to show. Default 12."),
    }),
    handler: async (a) =>
      withAccount(ctx, a.account, async (id: string) => {
        const items = Object.fromEntries(live(id).map((i) => [i.id, i]));
        const show = (ids: string[]) =>
          ids
            .map((x) => {
              const it = items[x];
              return it
                ? `  ${it.id}  ${it.name} — ledger says ${amount(it)} in the ${it.loc}`
                : `  ${x}`;
            })
            .join("\n");

        if (a.action === "photos") {
          if (!a.files?.length) return text("Give me the image paths.", true);
          const missing = a.files.filter((f: string) => !existsSync(f));
          if (missing.length) return text(`Cannot read: ${missing.join(", ")}`, true);
          const read = await readShelves(id, a.files, a.where);
          const ids = Object.keys(read.proposed);
          if (!ids.length) {
            return text(
              `Nothing in those photos lines up with anything the ledger tracks.${read.unknown.length ? `\nVisible but untracked: ${read.unknown.join(", ")}` : ""}`,
            );
          }
          const s = startSession(id, {
            by: a.by ?? null,
            source: "photos",
            only: ids,
            proposed: read.proposed,
          });
          const line = (x: string) => {
            const v = read.proposed[x]!;
            const it = items[x];
            const said =
              v.kind === "have"
                ? "still there"
                : v.kind === "gone"
                  ? "NOT there"
                  : `${v.qty}${it?.unit ? ` ${it.unit}` : ""} rather than ${amount(it!)}`;
            return `  ${x}: ${said}${read.because[x] ? ` — ${read.because[x]}` : ""}`;
          };
          return text(
            `Read ${a.files.length} photo(s)${a.where ? ` of the ${a.where}` : ""}. Session ${s.id}, PROPOSED ONLY, nothing written.\n\n${ids.map(line).join("\n")}${
              read.unknown.length ? `\n\nVisible but not tracked: ${read.unknown.join(", ")}` : ""
            }${read.note ? `\n\nWhat it could not see: ${read.note}` : ""}\n\nConfirm with the human before applying. Correct anything wrong with action:"answer", then action:"apply".`,
          );
        }

        if (a.action === "start") {
          const s = startSession(id, { by: a.by ?? null });
          if (!s.queue.length) {
            return text(
              "Nothing is worth asking about: everything has been seen or logged " +
                "in the last couple of days.",
            );
          }
          const n = a.limit ?? 12;
          return text(
            `Pass ${s.id} open${a.by ? ` for ${a.by}` : ""}, ${s.queue.length} worth checking, most informative first.\n\n${show(s.queue.slice(0, n))}\n\nAsk about these, then record with action:"answer". Nothing is written until apply.`,
          );
        }

        const s = a.session
          ? (readSessions(id).find((x) => x.id === a.session) ?? null)
          : openSession(id, a.by ?? undefined);
        if (!s) return text('No open pass. Start one with action:"start" or "photos".', true);

        if (a.action === "status") {
          const p = progress(s);
          return text(
            `Pass ${s.id}${s.by ? ` (${s.by})` : ""}, from ${s.source}. ${p.done} answered, ${p.left} left${s.applied ? `, applied ${s.applied}` : ""}.${p.left ? `\n\n${show(s.queue.slice(0, a.limit ?? 12))}` : ""}`,
          );
        }

        if (a.action === "answer") {
          if (!a.answers?.length) return text("No answers given.", true);
          let n = 0;
          for (const ans of a.answers) {
            if (!items[ans.item]) continue;
            const v: Verdict =
              ans.verdict === "gone"
                ? { kind: "gone" }
                : ans.verdict === "amount" && typeof ans.qty === "number"
                  ? { kind: "amount", qty: ans.qty, unit: items[ans.item]!.unit }
                  : { kind: "have" };
            if (answerCheck(id, s.id, ans.item, v, s.by)) n++;
          }
          const p = progress(s);
          return text(
            `Recorded ${n}. ${p.done} answered, ${p.left} left. Still nothing in the ledger; call action:"apply" when the human is done.`,
          );
        }

        const res = applySession(id, s.id);
        if (!res) return text("Nothing to apply on that pass.", true);
        return text(
          `Written as batch ${res.batch}, undoable in one go.\n` +
            `  confirmed as listed: ${res.confirmed}\n` +
            `  taken off the shelves: ${res.removed.map((r) => r.name).join(", ") || "none"}\n` +
            `  recounted: ${res.corrected.map((c) => `${c.name} ${c.from} -> ${c.to}`).join(", ") || "none"}`,
        );
      }),
  });

  // ─── getting somebody started ────────────────────────────────────────────

  tools.push({
    name: "kitchen_onboard",
    description:
      "Turn somebody who keeps asking for recipes into somebody with a kitchen. " +
      "Call `check` the moment a food question comes from a chat with no household — " +
      "it says whether to offer and what is missing, and never throws for a stranger. " +
      "Then, only after they have said yes: `start` provisions the whole thing at once, " +
      "`stock` reads photos of their fridge and cupboards into proposed items, and " +
      "`accept` puts the confirmed ones on the shelves as one undoable batch.\n\n" +
      "ASK FOR TWO THINGS AND NO MORE: who eats there, and photographs. Everything " +
      "else — when they eat, what they spend, how often they cook, what they like — " +
      "is derived from the log and asking for it up front makes the answer worse, not " +
      "better. The optional arguments here are for capturing what somebody volunteers " +
      "in conversation, never a checklist to run through them.",
    inputSchema: z.object({
      account: Acct,
      action: z.enum(["check", "start", "stock", "accept"]),
      id: z
        .string()
        .nullish()
        .describe('start: the household id to create, e.g. "morgan". Lowercase, dashes.'),
      principal: z
        .string()
        .nullish()
        .describe("start: whose kitchen it is. Omit to use this chat session."),
      person: z
        .string()
        .nullish()
        .describe("start: what to call them. The page is titled from this."),
      name: z.string().nullish().describe("start: a name for the household."),
      budget: z.number().nullish().describe("start: only if they volunteered a weekly figure."),
      avoid: z
        .array(z.string())
        .optional()
        .describe('start: only if they volunteered it, e.g. ["no pork"].'),
      stores: z.array(z.string()).optional().describe("start: only if they volunteered it."),
      lat: z.number().nullish().describe("start: for weather on their page. Only if known."),
      lon: z.number().nullish(),
      place: z.string().nullish().describe("start: label for those coordinates."),
      files: z.array(z.string()).optional().describe("stock: absolute paths to the photos."),
      where: z.string().nullish().describe("stock: 'the fridge', 'the pantry shelf'."),
      items: z
        .array(
          z.object({
            name: z.string(),
            cat: z.string().nullish(),
            loc: z.string().nullish(),
            qty: z.number().nullish(),
            unit: z.string().nullish(),
          }),
        )
        .optional()
        .describe("accept: the proposals a human actually confirmed."),
    }),
    handler: async (a) => {
      // `check` is the one action that must answer for somebody with no kitchen,
      // which is the entire population this tool exists for. Everything else
      // goes through withAccount and its hard failure.
      if (a.action === "check") {
        const who = a.principal ?? ctx.sessionKey ?? null;
        const id = a.account ?? accountOf(who);
        const st = state(id);
        if (!id) {
          return text(
            `${who ?? "This chat"} has no kitchen.\n\nIf they are asking about food for the second or third time, this is the moment to offer — in your own words, roughly: you have been asking me what to cook, and I can keep answering from nothing, or I can actually track what is in your kitchen and answer from that. Say what it gets them (what is actually cookable tonight, what is about to go off, what they spend) and that setting it up is two photos and one question.\n\nDo NOT provision anything until they say yes. If they do: kitchen_onboard action:"start" id:"<something-short>" person:"<their name>".`,
          );
        }
        return text(
          `${st.summary}\n\n${st.steps
            .map(
              (s) =>
                `  [${s.done ? "x" : " "}] ${s.id} — ${s.what}${s.done ? "" : `\n        next: ${s.next}`}`,
            )
            .join(
              "\n",
            )}${st.ready ? "\n\nSet up. Answer their food questions from the ledger." : ""}`,
        );
      }

      if (a.action === "start") {
        const who = a.principal ?? ctx.sessionKey ?? null;
        if (!who) return text("No principal, and this chat session did not identify one.", true);
        if (!a.id) return text('Give me an id for the household, e.g. "morgan".', true);
        try {
          const res = provision(a.id, {
            principal: who,
            person: a.person,
            name: a.name,
            budget: a.budget,
            avoid: a.avoid,
            stores: a.stores,
            place:
              typeof a.lat === "number" && typeof a.lon === "number"
                ? { lat: a.lat, lon: a.lon, label: a.place ?? null }
                : null,
          });
          return text(
            `${res.created ? "Created" : "Updated"} "${res.account}".\n\n${res.state.steps
              .map((s) => `  [${s.done ? "x" : " "}] ${s.id}${s.done ? "" : ` — ${s.next}`}`)
              .join(
                "\n",
              )}\n\nNext: ask for a photo of the fridge and one of a cupboard, then kitchen_onboard action:"stock". After that kitchen_site to build their page.`,
          );
        } catch (e) {
          return text(e instanceof Error ? e.message : String(e), true);
        }
      }

      return withAccount(ctx, a.account, async (id: string) => {
        if (a.action === "stock") {
          if (!a.files?.length) return text("Give me the image paths.", true);
          const missing = a.files.filter((f: string) => !existsSync(f));
          if (missing.length) return text(`Cannot read: ${missing.join(", ")}`, true);
          const read = await firstStock(a.files, a.where);
          if (!read.proposals.length) {
            return text(`Nothing readable as food in those. ${read.note}`);
          }
          return text(
            `${read.proposals.length} things visible. NOT on the shelves yet — show this to them, drop what is wrong, then action:"accept" with what survives.\n\n${table(
              read.proposals.map((p) => [
                p.name,
                p.qty === null
                  ? "some"
                  : `${p.qty}${p.unit && p.unit !== "ct" ? ` ${p.unit}` : ""}`,
                p.cat,
                p.loc,
                p.because.slice(0, 60),
              ]),
              ["item", "how much", "kind", "where", "why"],
            )}\n\n${read.note}`,
          );
        }

        if (!a.items?.length) return text("Nothing to accept.", true);
        const res = acceptStock(
          id,
          a.items.map(
            (i: {
              name: string;
              cat?: string | null;
              loc?: string | null;
              qty?: number | null;
              unit?: string | null;
            }) => ({
              id: slug(i.name),
              name: i.name,
              cat: (CATEGORIES as readonly string[]).includes(i.cat ?? "")
                ? (i.cat as never)
                : ("other" as never),
              loc: (LOCATIONS as readonly string[]).includes(i.loc ?? "")
                ? (i.loc as never)
                : ("pantry" as never),
              qty: typeof i.qty === "number" ? i.qty : null,
              unit: i.unit ?? null,
              because: "confirmed during setup",
            }),
          ),
        );
        const st = state(id);
        return text(
          `${
            (res.batch
              ? `On the shelves: ${res.added.map((p) => p.name).join(", ")} (batch ${res.batch}, undo with kitchen_undo).`
              : "Everything there was already tracked.") +
            (res.skipped.length ? `\nAlready had: ${res.skipped.join(", ")}.` : "")
          }\n\n${st.summary}`,
        );
      });
    },
  });

  return tools;
}
