/**
 * Households and their websites: membership, preferences, health checks, and
 * rendering the site.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import {
  createAccount,
  getAccount,
  householdTitle,
  joinAccount,
  leaveAccount,
  listAccounts,
  resolveAccount,
  updateAccount,
} from "../src/accounts.ts";
import { scanAssets } from "../src/assets.ts";
import { STORES } from "../src/deals.ts";
import { checkAccount, checkAll, format, summarise } from "../src/doctor.ts";
import { learnedSchedule } from "../src/insights.ts";
import { writeSite } from "../src/site.ts";
import { readLog } from "../src/store.ts";
import { table } from "../src/util.ts";
import { Acct, failure, text, withAccount } from "./shared.ts";

export function householdTools(ctx: ToolContext): ToolDef[] {
  return [
    {
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
            // Every household when none is named: the broken one is usually not this one.
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
            // Outside a chat session there is no `me`; never write a null member.
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
          return failure(e);
        }
      },
    },

    {
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
          // Photos are scanned from the output directory so the page only links
          // images that exist.
          const assets = scanAssets(target);
          // One call writes the hub, every recipe page and the chat threads, so the
          // hub never links to a page that was not written.
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
    },
  ];
}
