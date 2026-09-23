/**
 * The shopping list and what it costs: the list by reason, answers about
 * restocking, the Apple Notes copy, and store prices.
 */

import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import { getAccount, updateAccount } from "../src/accounts.ts";
import { STORES, bestBasket, bestDeals, importPrices, loadPrices } from "../src/deals.ts";
import { addToList } from "../src/list.ts";
import { WAIT_MS, syncNote } from "../src/notesync.ts";
import { markHandled } from "../src/requests.ts";
import { setDisposition, skip } from "../src/restock.ts";
import { priceMaxAgeDays } from "../src/settings.ts";
import { answerTarget, shopping, tripCount } from "../src/shopping.ts";
import { fold, match, slug } from "../src/store.ts";
import { table } from "../src/util.ts";
import { Acct, isWaiting, rerender, text, withAccount } from "./shared.ts";

export function shoppingTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "kitchen_shopping",
      description:
        "The shopping list, split by WHY each line is on it: gaps in a meal that was " +
        "planned, staples that ran out, and lines somebody wrote down. Also returns the " +
        "suggestion tray — things that ran out but have never been confirmed as worth " +
        "rebuying, which are deliberately NOT on the list. Use this rather than reading " +
        "stock yourself: 'what do we need' and 'what is out' are different questions and " +
        "answering the second one as if it were the first is what fills a list with noise. " +
        "Set `answer` to record a decision, `add` to put lines on the list yourself " +
        "(what a dish needs from a supermarket is your call, after kitchen_status: real " +
        "products, nothing the house already owns, staples assumed), or `notes` to push " +
        "the list into Apple Notes.",
      inputSchema: z.object({
        account: Acct,
        add: z
          .array(
            z.object({
              name: z.string().describe("What to look for on the shelf: 'panko breadcrumbs'."),
              amount: z.string().nullish().describe("As a shopper says it: '8 oz', 'one jar'."),
              cat: z
                .string()
                .nullish()
                .describe(
                  "produce|meat|seafood|dairy|frozen|bakery|pantry|condiment|spice|drink|snack|other",
                ),
              item: z
                .string()
                .nullish()
                .describe("Ledger slug when this restocks something the house has owned."),
              why: z.string().nullish().describe("Shown on the line: 'for chicken parm'."),
              by: z.string().nullish().describe("Principal who asked, when it was a site tap."),
            }),
          )
          .optional(),
        key: z
          .string()
          .nullish()
          .describe(
            "The site tap this answers (its key from the wake-up or kitchen_requests), " +
              "so it is marked served.",
          ),
        answer: z
          .object({
            item: z
              .string()
              .describe(
                "The item the decision is about: its ledger slug, or its name as the list " +
                  "shows it. Refused, with nothing written, if it matches nothing.",
              ),
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
      handler: async ({ account, add, key, answer, notes, share, shareWith, noteTitle: wanted }) =>
        withAccount(ctx, account, async (id) => {
          const said: string[] = [];
          if (key && !isWaiting(id, "addlist", key))
            return text(`No shopping request is waiting with key ${key}.`, true);
          // Resolved before any write, so an answer naming nothing changes nothing.
          const target = answer ? answerTarget(id, answer.item) : null;
          if (target && !target.ok) return text(`Nothing was recorded. ${target.why}`, true);
          if (add?.length) {
            const { added, merged } = addToList(
              id,
              add.map(
                (b: {
                  name: string;
                  amount?: string | null;
                  cat?: string | null;
                  item?: string | null;
                  why?: string | null;
                  by?: string | null;
                }) => ({
                  name: b.name,
                  amount: b.amount ?? null,
                  cat: b.cat ?? null,
                  item: b.item ?? null,
                  why: b.why ?? null,
                  by: b.by ?? null,
                }),
              ),
            );
            said.push(
              `On the list: ${added.map((a) => a.name).join(", ") || "nothing new"}${
                merged.length ? ` (${merged.length} already there)` : ""
              }.`,
            );
            const render = rerender(id);
            if (render) said.push(render);
          }
          if (key) {
            markHandled(id, [key]);
            said.push("Marked that site tap served.");
          }
          if (wanted?.trim()) {
            updateAccount(id, { note_list: wanted.trim() });
            said.push(
              `The list will be written into the note called "${wanted.trim()}" from now on.`,
            );
          }
          if (answer && target?.ok) {
            if (answer.as === "skip") skip(id, [target.id], tripCount(id));
            else setDisposition(id, [target.id], answer.as, "asked in chat");
            said.push(
              `Recorded: ${target.name} (${target.id}) is ${
                answer.as === "always"
                  ? "kept stocked from now on"
                  : answer.as === "never"
                    ? "a one-off and will not be suggested again"
                    : "off this trip's list"
              }.`,
            );
          }
          // Writing and sharing happen in one note session, which reads the note
          // first so ticks made in a shop survive the write.
          if (notes || share) {
            // Queue behind the background pass: two writers would mangle the note.
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
    },

    {
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
          // Priced against the real list, not a second derivation that could disagree.
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
    },

    {
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
    },
  ];
}
