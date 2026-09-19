/**
 * Reading a photograph of a shelf against what the ledger believes.
 *
 * The fastest way to correct a kitchen is not to answer thirty questions, it is
 * to open the fridge door and take one picture. This turns that picture into a
 * set of proposals: things the ledger has that the photo confirms, things it has
 * that are visibly not there, counts that are visibly wrong, and things sitting
 * in the picture that the ledger has never heard of.
 *
 * PROPOSALS, NEVER WRITES. Nothing here touches the ledger. A photograph is
 * evidence, not testimony: it shows one shelf at one angle, half the fridge is
 * behind the milk, and a closed drawer is not an empty drawer. The output is a
 * deck of questions for a human, pre-answered with what the picture suggests,
 * which is the fastest honest thing it can be. This is the same rule the whole
 * integration runs on and the one I have broken before by treating absence in a
 * photo as evidence of absence in the world.
 *
 * WHAT A READING IS ALLOWED TO SAY. Only three things, and only about slugs the
 * ledger already knows: I can see it, I cannot see it, I can see a different
 * amount. Anything spotted that is untracked comes back separately as a
 * suggestion to add, never as an automatic add, because a jar on a counter in
 * one photo is not a kitchen inventory.
 *
 * WHO LOOKS. Me, at the actual pictures, in the chat they arrived in. The
 * reading used to be delegated to a vision model on OpenRouter with the ledger
 * pasted into its prompt; that prompt is now `shelfBrief`, handed back to me
 * as the checklist, and `proposeShelves` is the same coercion applied to what
 * I say I saw.
 */

import type { Verdict } from "./reconcile.ts";
import { amount, live } from "./store.ts";

export type ShelfRead = {
  /** Ledger slugs the photos speak to, with what they suggest. */
  proposed: Record<string, Verdict>;
  /** Plain-English reason per slug, shown on the card so a person can disagree. */
  because: Record<string, string>;
  /** Visible but untracked, as free text. Suggestions only, never added. */
  unknown: string[];
  /** What the reading could NOT see, so nobody mistakes silence for absence. */
  note: string;
};

/**
 * The checklist to read the pictures against.
 *
 * The ledger goes in as a checklist rather than an open question, because "what
 * food is in this photo" produces a shopping catalogue and "which of these
 * eleven things can you see" produces an answer that can be acted on.
 */
export function shelfBrief(account: string, files: string[], where?: string | null): string {
  const checklist = live(account)
    .map((i) => `${i.id} = ${i.name}, ledger says ${amount(i)}, kept in the ${i.loc}`)
    .sort()
    .join("\n");
  return [
    `Look at ${files.length === 1 ? "this photograph" : `these ${files.length} photographs`} of the kitchen${where ? `, specifically the ${where}` : ""}:`,
    files.map((f) => `  ${f}`).join("\n"),
    "",
    "Here is what the ledger currently believes is in the house. Go through it and say",
    "only what the PHOTOGRAPHS actually show:",
    checklist || "  (nothing tracked yet)",
    "",
    "Rules, and the first one matters most:",
    "",
    "1. NOT VISIBLE IS NOT GONE. If you cannot see something, say nothing about it.",
    "   Half a fridge is behind the milk and a closed drawer is not an empty drawer.",
    "   Only report gone when the photo shows the place that thing lives and it is",
    "   clearly not there. When in doubt, leave it out entirely.",
    "2. Only report a count when you can actually count it. Four visible apples in a",
    "   bag that continues out of frame is not four apples.",
    "3. Anything you can see that is NOT on the list goes in unknown as plain words.",
    "   Do not guess a slug for it.",
    "",
    `Then kitchen_check action:"propose" with seen:[{item: slug, verdict: have|gone|amount,`,
    `qty, because: what in the photo makes you say that}], unknown:[...], note: one`,
    "sentence on what these photos could not show. That opens the pass as PROPOSED",
    "ONLY; the person confirms before anything is written.",
  ].join("\n");
}

export type SeenLine = {
  item: string;
  verdict: "have" | "gone" | "amount";
  qty?: number | null;
  because?: string | null;
};

/**
 * What I said I saw, as proposals against the ledger.
 *
 * A slug the ledger has never heard of cannot be reconciled against anything,
 * so it is dropped rather than shown as a mystery card.
 */
export function proposeShelves(
  account: string,
  seen: SeenLine[],
  unknown: string[] = [],
  note = "",
): ShelfRead {
  const known = new Map(live(account).map((i) => [i.id, i]));
  const proposed: Record<string, Verdict> = {};
  const because: Record<string, string> = {};
  for (const s of seen) {
    if (!s?.item || !known.has(s.item)) continue;
    if (s.verdict === "gone") proposed[s.item] = { kind: "gone" };
    else if (s.verdict === "amount" && typeof s.qty === "number") {
      proposed[s.item] = { kind: "amount", qty: s.qty, unit: known.get(s.item)!.unit };
    } else proposed[s.item] = { kind: "have" };
    if (s.because) because[s.item] = s.because;
  }
  return {
    proposed,
    because,
    unknown: unknown.filter((u) => typeof u === "string").slice(0, 30),
    note,
  };
}
