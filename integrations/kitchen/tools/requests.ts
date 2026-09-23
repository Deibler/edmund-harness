/**
 * The household site's two-way traffic: standing dinner texts, taps waiting for
 * an answer, the on-page chat, and favourites and notes.
 */

import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import { eaters, getAccount } from "../src/accounts.ts";
import { appendTurn, openQuestions, publishThreads, readThread } from "../src/chat.ts";
import { shoppingList } from "../src/insights.ts";
import { addNote, loadProfiles, toggleFavorite } from "../src/profile.ts";
import { markHandled, pending, requestKey } from "../src/requests.ts";
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
} from "../src/schedules.ts";
import { Acct, text, withAccount } from "./shared.ts";

export function requestTools(ctx: ToolContext): ToolDef[] {
  return [
    {
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
          .describe(
            "set: a standing steer like 'something quick'. Nudges the pick, never filters.",
          ),
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
    },

    {
      name: "kitchen_requests",
      description:
        "Taps on the website waiting for an answer from you: Make on a dish never written " +
        "out, Make a variant, Write one for the clock, a question typed on the page or " +
        "asked out loud, a shopping pick, an explore theme, an explore idea to write up. " +
        "Returns them oldest first, each with the tool that answers it. kitchen_voice, " +
        "kitchen_explore save and kitchen_shopping key mark their own tap served; for the " +
        "rest pass `handled` with the keys AFTER the answer has landed. A request served " +
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
                  case "voice":
                    return `${head}\n  asked out loud${r.recipe ? ` on ${r.recipe}${r.step ? ` step ${r.step}` : ""}` : ""}: ${r.text ?? ""}\n  answer: kitchen_voice profile:"${r.profile ?? ""}" rid:"${r.rid ?? ""}" say:"..."`;
                  case "addlist":
                    return `${head}\n  wants ${r.name ?? r.recipe} shopped for; picked: ${[...(r.items ?? []), ...(r.missing ?? [])].join(", ") || "(nothing)"}\n  answer: kitchen_status, then kitchen_shopping add:[...] key:"${requestKey(r)}"`;
                  case "explore":
                    return `${head}\n  wants dishes unlike anything this house cooks${r.text?.trim() ? `, theme: ${r.text.trim()}` : ""}\n  answer: kitchen_explore action:"brief", then action:"save"`;
                  case "idearecipe":
                    return `${head}\n  write the explore idea ${r.recipe} "${r.name ?? ""}" out as a recipe page\n  answer: kitchen_recipe_save (its buy list is on the explore page), text them the page, then handled`;
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
    },

    {
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
          // Republish now so the answer appears within one poll of the page.
          const published = dir ? publishThreads(id, people, dir) : 0;
          const turns = readThread(id, a.profile, 12);
          return text(
            (a.reply ? `Answered. Published to ${published} thread file(s).\n\n` : "") +
              turns.map((t) => `${t.from === "me" ? "me " : "them"}: ${t.text}`).join("\n"),
          );
        }),
    },

    {
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
    },
  ];
}
