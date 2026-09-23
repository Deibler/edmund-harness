/**
 * Reading a photograph of a shelf against what the ledger believes.
 *
 * Produces proposals only, never writes: a photo shows one shelf from one
 * angle, and a closed drawer is not an empty drawer. A reading may say three
 * things about items the ledger already tracks (seen, visibly gone, a different
 * amount); anything untracked comes back separately as a suggestion.
 *
 * The model reads the photographs itself: `shelfBrief` is the checklist it reads
 * them against, and `proposeShelves` turns what it reports into proposals that a
 * person confirms before anything is written.
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
 * The checklist to read the pictures against. A closed question ("which of
 * these can you see") gives answers that can be acted on; an open one ("what
 * food is here") gives a catalogue.
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
 * The model's reading, as proposals against the ledger. Slugs the ledger does
 * not track cannot be reconciled, so they are dropped.
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
