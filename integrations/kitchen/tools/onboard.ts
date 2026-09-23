/**
 * Onboarding: turning somebody who asks for recipes into a household with a
 * kitchen, from one question and a few photos.
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import { acceptStock, accountOf, provision, state, stockBrief } from "../src/onboard.ts";
import { slug } from "../src/store.ts";
import { CATEGORIES, LOCATIONS } from "../src/types.ts";
import { Acct, failure, text, withAccount } from "./shared.ts";

export function onboardTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "kitchen_onboard",
      description:
        "Turn somebody who keeps asking for recipes into somebody with a kitchen. " +
        "Call `check` the moment a food question comes from a chat with no household — " +
        "it says whether to offer and what is missing, and never throws for a stranger. " +
        "Then, only after they have said yes: `start` provisions the whole thing at once, " +
        "`stock` hands you the brief for reading photos of their fridge and cupboards " +
        "into a list of what is visible (you look, they confirm), and `accept` puts the " +
        "confirmed ones on the shelves as one undoable batch.\n\n" +
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
        // `check` must answer for somebody with no household; the rest go through
        // withAccount.
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
            }\n\n${st.summary}`,
          );
        });
      },
    },
  ];
}
