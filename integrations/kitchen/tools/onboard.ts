/**
 * Onboarding: turning somebody who asks for recipes into a household with a
 * kitchen, from one question and a few photos, then a first week of check-ins.
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import { getGroupParticipants } from "../../../src/imessage/participants.ts";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import { dmKeyFor } from "../../../src/sessions/key.ts";
import { joinAccount, nameMembers } from "../src/accounts.ts";
import {
  HOW_IT_WORKS,
  acceptStock,
  accountOf,
  checkinBrief,
  provision,
  scheduleCheckins,
  state,
  stockBrief,
} from "../src/onboard.ts";
import { decline, forget } from "../src/prospects.ts";
import { slug } from "../src/store.ts";
import { CATEGORIES, LOCATIONS } from "../src/types.ts";
import { Acct, failure, noKitchen, text, withAccount } from "./shared.ts";

export function onboardTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "kitchen_onboard",
      description:
        "Turn somebody who asks about food into somebody with a kitchen. A chat with no " +
        "household is told by kitchen_status (or `check`) to answer first and whether to " +
        "offer one this time; `decline` records a no, which is final. Only after a yes: " +
        "`start` provisions the whole thing at once (in a small group, everyone in it is " +
        "linked) and queues three first-week check-ins, `stock` hands you the brief for " +
        "reading photos of their fridge and cupboards into a list of what is visible (you " +
        "look, they confirm), and `accept` puts the confirmed ones on the shelves as one " +
        "undoable batch. `checkin` is what those wake-ups call.\n\n" +
        "ASK FOR TWO THINGS AND NO MORE: who eats there, and photographs. Everything " +
        "else — when they eat, what they spend, how often they cook, what they like — " +
        "is derived from the log and asking for it up front makes the answer worse, not " +
        "better. The optional arguments here are for capturing what somebody volunteers " +
        "in conversation, never a checklist to run through them.",
      inputSchema: z.object({
        account: Acct,
        action: z.enum(["check", "decline", "start", "stock", "accept", "checkin"]),
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
        kind: z
          .enum(["dinner", "receipt", "recap"])
          .nullish()
          .describe("checkin: which one, as the wake-up names it."),
      }),
      handler: async (a) => {
        // These answer for a chat with no household, so they run before withAccount.
        if (a.action === "check") {
          const id = a.account ?? accountOf(a.principal ?? ctx.sessionKey ?? null);
          if (!id) return noKitchen(ctx);
          const st = state(id);
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

        if (a.action === "decline") {
          if (!ctx.sessionKey) return text("This chat session did not identify itself.", true);
          decline(ctx.sessionKey);
          return text(
            "Noted. Do not offer a kitchen in this chat again unless they bring it up themselves.",
          );
        }

        if (a.action === "checkin") {
          if (!a.kind) return text('Which check-in? kind:"dinner", "receipt" or "recap".', true);
          return text(checkinBrief(accountOf(ctx.sessionKey ?? null), a.kind));
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
            // In a small group that said yes, everyone in it shares the kitchen,
            // so each of them can ask about it from their own chat too.
            const linked: string[] = [];
            const guid = ctx.chatGuids?.[0];
            if (res.created && who.startsWith("imessage:group:") && ctx.chatDb && guid) {
              for (const h of getGroupParticipants(ctx.chatDb, guid)) {
                const dm = dmKeyFor(h);
                if (accountOf(dm)) continue;
                joinAccount(res.account, dm);
                linked.push(ctx.contacts?.displayName(h)?.trim().split(/\s+/)[0] || h);
              }
            }
            // Names the phone already knows are never asked for.
            nameMembers(res.account, (h) => ctx.contacts?.displayName(h) ?? null);
            forget(who);
            const checkins =
              res.created && ctx.cron
                ? scheduleCheckins(res.account, who, (input) => ctx.cron.create(input))
                : [];
            const st = state(res.account);
            return text(
              [
                `${res.created ? "Created" : "Updated"} "${res.account}".`,
                st.steps
                  .map((s) => `  [${s.done ? "x" : " "}] ${s.id}${s.done ? "" : ` — ${s.next}`}`)
                  .join("\n"),
                linked.length
                  ? `Linked ${linked.join(" and ")}'s own chats too, so any of them can ask you about this kitchen.`
                  : null,
                checkins.length
                  ? "Queued three first-week check-ins in this chat: tomorrow afternoon a dinner from their shelves, day 4 a receipt nudge if none has come in, day 7 a short recap. Each decides when it fires whether it is still needed."
                  : null,
                'Next: if their original question is still unanswered, answer it now. Then ask for a photo of the fridge and one of a cupboard (more is welcome), then kitchen_onboard action:"stock". After that kitchen_site, which publishes their page and returns the link once it answers.',
              ]
                .filter(Boolean)
                .join("\n\n"),
            );
          } catch (e) {
            return failure(e);
          }
        }

        return withAccount(ctx, a.account, async (id: string) => {
          if (a.action === "stock") {
            if (!a.files?.length) return text("Give me the image paths.", true);
            const missing = a.files.filter((f: string) => !existsSync(f));
            if (missing.length) return text(`Cannot read: ${missing.join(", ")}`, true);
            return text(stockBrief(a.files, a.where));
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
            }\n\n${st.summary}${
              st.steps.find((x) => x.id === "site")?.done
                ? ""
                : `\n\nNext: kitchen_site publishes their page and returns the link.\n\n${HOW_IT_WORKS}`
            }`,
          );
        });
      },
    },
  ];
}
