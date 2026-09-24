/**
 * The cookbook: long-form recipes, written once and kept, with variants grouped
 * under the dish they came from.
 */

import { z } from "zod";
import type { ToolContext } from "../../../src/mcp/context.ts";
import type { ToolDef } from "../../../src/mcp/tools/types.ts";
import {
  type BuiltRecipe,
  getRecipe,
  groupRecipes,
  loadCookbook,
  saveRecipe,
  variantId,
} from "../src/cookbook.ts";
import { writtenAvoids } from "../src/recipes.ts";
import { slug } from "../src/store.ts";
import { Acct, text, withAccount } from "./shared.ts";

const IngredientS = z.object({
  name: z.string(),
  amount: z.string().describe('Free text, e.g. "1 medium, diced" or "a splash".'),
  item: z.string().nullish().describe("Ledger slug when this maps to tracked stock."),
  note: z.string().nullish(),
});

const StepS = z.object({
  n: z.number().int().positive(),
  title: z.string().describe('The imperative, e.g. "Sear the chops".'),
  /** A short lede rendered above the numbered actions, not the instructions. */
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
   * What this step puts in the pan, with the amount for this step. Without it
   * the page falls back to the whole-dish (shopping) amount.
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
  /** The step as single actions; the recipe page renders one per line. */
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

/**
 * An unattended-pan cue: a verb right after the subject ("while that cooks") or
 * an -ing after is/are ("while the rice is simmering"). Conditions such as
 * "while it is still hot" are not a second task and do not match.
 */
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

/**
 * The ways a saved recipe will read badly on its page, as text to append to the
 * save result. Such a recipe still saves and renders, so the problems are named
 * at the moment they are cheap to fix.
 */
function stepWarnings(steps: BuiltRecipe["steps"]): string {
  const list = (ns: number[]) => `step${ns.length === 1 ? "" : "s"} ${ns.join(", ")}`;
  // Without `uses` the page infers ingredients and shows the whole-dish amount.
  const bare = steps.filter((s) => !s.uses?.length).map((s) => s.n);
  const unsplit = steps.filter((s) => !s.parts?.length).map((s) => s.n);
  const wordy = steps
    .filter((s) => s.parts?.length && s.body && s.body.length > 220)
    .map((s) => s.n);
  const juggling = steps
    .filter((s) => (s.parts ?? []).some((x) => CONCURRENT.test(x)) || CONCURRENT.test(s.body))
    .map((s) => s.n);
  return `${
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
  }`;
}

/**
 * A written recipe that uses something on the avoid list is saved anyway: it
 * exists because somebody asked for it, and the avoid list governs what the
 * kitchen offers, not what a person may ask for. It is never suggested
 * (`offered`), and the model is told so at the moment it can still rewrite it.
 */
function avoidWarning(account: string, r: BuiltRecipe): string {
  const hit = writtenAvoids(account, r);
  return hit
    ? `\n\nAVOIDED: this uses ${hit}, which this household avoids. It is saved and its page works, but it will never be suggested (home page, dinner texts, shopping ideas). If nobody asked for it by name, write it again without ${hit}.`
    : "";
}

export function recipeTools(ctx: ToolContext): ToolDef[] {
  return [
    {
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
    },

    {
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
            // Copied field by field: a field added to StepS must be added here too,
            // or it is silently dropped.
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
          return text(
            `Saved "${saved.name}" as ${saved.id}${saved.base ? ` (variant of ${saved.base})` : ""}. Re-render the site to publish it.${avoidWarning(id, saved)}${stepWarnings(saved.steps)}`,
          );
        }),
    },

    {
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
    },
  ];
}
