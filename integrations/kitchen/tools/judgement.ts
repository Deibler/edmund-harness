/**
 * Answers that need judgement about food and about the household: meal ideas,
 * the explore shelf, and questions asked aloud at the stove. `brief` actions
 * return the material to write from; `save` actions validate what was written.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import { accountDir, eaters, getAccount } from "../src/accounts.ts";
import { exploreBrief, saveExplore } from "../src/explore.ts";
import { IDEAS_TARGET, ideasBrief, readOverlay, saveIdeas } from "../src/ideas.ts";
import { markHandled, pending, requestKey } from "../src/requests.ts";
import { MAX_WORDS, sayVoice } from "../src/voice.ts";
import { Acct, isWaiting, rerender, text, withAccount } from "./shared.ts";

/**
 * Generate pictures for new cards in a detached process, so the tool call does
 * not hold the chat while images render. The cards show at once; photos follow.
 */
function photographInBackground(id: string): void {
  const script = join(import.meta.dir, "..", "scripts", "photos.ts");
  const log = openSync(join(accountDir(), "..", "photos.log"), "a");
  spawn(process.execPath, [script, id], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  }).unref();
  closeSync(log);
}

const EffortS = z.enum(["quick", "weeknight", "project", "allday"]);
const MethodS = z.enum([
  "stovetop",
  "oven",
  "sheetpan",
  "crockpot",
  "instantpot",
  "grill",
  "airfryer",
  "nocook",
]);

const IdeaS = z.object({
  id: z.string().describe("kebab-case, unique on the site."),
  name: z.string(),
  desc: z.string().describe("One plain sentence, no marketing."),
  minutes: z.number().int().positive(),
  cat: z.string().default("dinner").describe("dinner|lunch|side|dessert|snack"),
  health: z.number().int().min(1).max(5).nullish(),
  needs: z
    .array(z.tuple([z.string(), z.number().nullable()]))
    .describe("[ledger slug, qty|null] from the brief, exactly. null means some."),
  effort: EffortS.nullish(),
  method: MethodS.nullish(),
});

const ExploreDishS = z.object({
  name: z.string(),
  desc: z.string().describe("One sentence: what it is and why it is good."),
  cuisine: z.string(),
  why: z.string().describe("One sentence on how it differs from what they cook."),
  buy: z.array(z.string()).describe("What they must go and get, in plain shopping words."),
  have: z.array(z.string()).describe("What it uses that they already own."),
  minutes: z.number().int().positive(),
  effort: EffortS,
  method: MethodS,
  spend: z.number().int().min(1).max(3),
  health: z.number().int().min(1).max(5),
});

export function judgementTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "kitchen_ideas",
      description:
        "This household's own dinner and lunch ideas: the cards built strictly from what " +
        "is on the shelves, refreshed by the morning pass. `brief` hands you the exact " +
        "ingredient slugs, what expires soonest, the names already taken and how this " +
        "house eats; write the ideas yourself, for these people, then `save`. Saving " +
        "validates every dish against the ledger and rejects any that names an ingredient " +
        "the house does not hold, so use the slugs exactly. The cards are on the page at " +
        "once; their pictures are generated afterwards in the background.",
      inputSchema: z.object({
        account: Acct,
        action: z.enum(["brief", "save"]),
        want: z
          .number()
          .int()
          .positive()
          .nullish()
          .describe("brief: how many to write. Defaults to what the page is short."),
        recipes: z.array(IdeaS).optional().describe("save: the dishes, shaped as the brief says."),
      }),
      handler: (a) =>
        withAccount(ctx, a.account, (id) => {
          const acct = getAccount(id)!;
          if (a.action === "brief") {
            const want = a.want ?? Math.max(0, IDEAS_TARGET - readOverlay(id).recipes.length);
            if (!want) return text("The page already has its full set of ideas; nothing to write.");
            return text(ideasBrief(id, acct, want));
          }
          if (!a.recipes?.length) return text("Nothing to save.", true);
          const res = saveIdeas(id, a.recipes);
          const said = [
            res.saved.length
              ? `Saved ${res.saved.length}: ${res.saved.map((r) => r.name).join(", ")}. On the page now, pictures on the way.`
              : "Nothing saved.",
            ...res.rejected.map((r) => `Rejected ${r.id}: ${r.why}.`),
          ];
          if (res.saved.length) {
            const render = rerender(id);
            if (render) said.push(render);
            photographInBackground(id);
          }
          return text(said.join("\n"), !res.saved.length);
        }),
    },

    {
      name: "kitchen_explore",
      description:
        "The explore shelf: dishes deliberately unlike anything this house cooks, written " +
        "by you. `brief` returns everything they already cook (the list to get away from), " +
        "everything they own (so the shopping line is honest) and any theme they typed; " +
        "write eight and `save`. Saving drops repeats of known dishes and anything on the " +
        "avoid list, moves owned " +
        "ingredients from buy to have, publishes the set, re-renders the page and marks " +
        "the explore taps that asked for it served.",
      inputSchema: z.object({
        account: Acct,
        action: z.enum(["brief", "save"]),
        theme: z
          .string()
          .nullish()
          .describe("What they asked for, if anything: 'something Korean', 'cheap and slow'."),
        key: z
          .string()
          .nullish()
          .describe(
            "save: the exact explore tap key from the wake-up, so only that tap is served.",
          ),
        dishes: z.array(ExploreDishS).optional().describe("save: the set."),
      }),
      handler: (a) =>
        withAccount(ctx, a.account, (id) => {
          if (a.action === "brief") return text(exploreBrief(id, a.theme));
          if (!a.dishes?.length) return text("Nothing to save.", true);
          if (a.key && !isWaiting(id, "explore", a.key))
            return text(`No explore request is waiting with key ${a.key}.`, true);
          const { set, dropped, avoided } = saveExplore(id, a.dishes, a.theme);
          if (a.key) markHandled(id, [a.key]);
          const render = rerender(id);
          return text(
            [
              `Published ${set.dishes.length}${set.theme ? ` for "${set.theme}"` : ""}: ${set.dishes.map((d) => d.name).join(", ")}.`,
              dropped.length
                ? `Dropped as repeats of what they already cook: ${dropped.join(", ")}.`
                : "",
              avoided.length
                ? `Dropped for using something this household avoids: ${avoided.join(", ")}.`
                : "",
              a.key ? "Marked that explore tap served." : "",
              render ?? "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }),
    },

    {
      name: "kitchen_voice",
      description:
        "Answer a question somebody asked OUT LOUD from a recipe page. The page is polling " +
        "for it: the words land in their browser and are read aloud in my voice, nothing " +
        "is texted. Under 70 words, spoken English, built on what kitchen_status says is " +
        "actually in the house and on the step they are looking at (kitchen_recipe_get). " +
        "Marks the tap served.",
      inputSchema: z.object({
        account: Acct,
        profile: z.string().describe("Whose question: the principal from the wake-up."),
        rid: z.string().describe("The question id the page is polling for."),
        say: z.string().describe("The answer, exactly as it will be spoken."),
      }),
      handler: (a) =>
        withAccount(ctx, a.account, async (id) => {
          const acct = getAccount(id)!;
          const dir = acct.site?.artifact;
          if (!dir) return text("No site directory recorded for this household yet.", true);
          if (!eaters(acct).some((e) => e.principal === a.profile))
            return text(`"${a.profile}" is not a member of this household.`, true);
          const say = a.say.trim();
          const words = say.split(/\s+/).filter(Boolean).length;
          if (!words) return text("Nothing to say.", true);
          if (words > MAX_WORDS)
            return text(
              `${words} words is too long to be read aloud at a stove. Keep it under ${MAX_WORDS}.`,
              true,
            );
          const req = pending(id, dir).find((r) => r.kind === "voice" && r.rid === a.rid);
          if (req?.profile && req.profile !== a.profile)
            return text(`That question was asked by ${req.profile}, not ${a.profile}.`, true);
          const turn = await sayVoice(dir, a.profile, { rid: a.rid, ask: req?.text ?? "", say });
          if (req) markHandled(id, [requestKey(req)]);
          return text(
            `${
              turn.audio
                ? "Spoken and on the page."
                : "On the page as text; speech synthesis failed, so the browser reads it in its own voice."
            }${req ? " Tap marked served." : " No question with that id was waiting, so nothing was marked."}`,
          );
        }),
    },
  ];
}
