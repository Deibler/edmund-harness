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
 * WHAT THE MODEL IS ALLOWED TO SAY. Only three things, and only about slugs the
 * ledger already knows: I can see it, I cannot see it, I can see a different
 * amount. Anything it spots that is untracked comes back separately as a
 * suggestion to add, never as an automatic add, because a jar on a counter in
 * one photo is not a kitchen inventory.
 */

import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { openrouterKey } from "./openrouter.ts";
import type { Verdict } from "./reconcile.ts";
import { amount, live } from "./store.ts";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".gif": "image/gif",
};

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
 * Ask what the pictures show.
 *
 * The ledger goes in as a checklist rather than an open question, because "what
 * food is in this photo" produces a shopping catalogue and "which of these
 * eleven things can you see" produces an answer that can be acted on.
 */
export async function readShelves(
  account: string,
  files: string[],
  where?: string | null,
): Promise<ShelfRead> {
  const stock = live(account);
  const known = new Map(stock.map((i) => [i.id, i]));
  const checklist = stock
    .map((i) => `${i.id} = ${i.name}, ledger says ${amount(i)}, kept in the ${i.loc}`)
    .sort()
    .join("\n");

  const images = files.map((f) => {
    const mime = MIME[extname(f).toLowerCase()] ?? "image/jpeg";
    return {
      type: "image_url" as const,
      image_url: { url: `data:${mime};base64,${readFileSync(f).toString("base64")}` },
    };
  });

  const prompt = [
    `These are photographs of one household's kitchen${where ? `, specifically the ${where}` : ""}.`,
    "",
    "Here is what the ledger currently believes is in the house. Go through it and say",
    "only what the PHOTOGRAPHS actually show:",
    checklist,
    "",
    "Rules, and the first one matters most:",
    "",
    "1. NOT VISIBLE IS NOT GONE. If you cannot see something, say nothing about it.",
    "   Half a fridge is behind the milk and a closed drawer is not an empty drawer.",
    "   Only report `gone` when the photo shows the place that thing lives and it is",
    "   clearly not there. When in doubt, leave it out entirely.",
    "2. Only report a count when you can actually count it. Four visible apples in a",
    "   bag that continues out of frame is not four apples.",
    "3. Anything you can see that is NOT on the list goes in `unknown` as plain words.",
    "   Do not guess a slug for it.",
    "",
    `Return JSON: {"seen":[{"item":"slug","verdict":"have|gone|amount","qty":number-or-null,`,
    `"because":"what in the photo makes you say that"}],"unknown":["what you saw"],`,
    `"note":"one sentence on what these photos could not show"}`,
  ].join("\n");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openrouterKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images] }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const parsed = JSON.parse(data.choices[0]!.message.content) as {
    seen?: Array<{ item?: string; verdict?: string; qty?: number | null; because?: string }>;
    unknown?: string[];
    note?: string;
  };

  const proposed: Record<string, Verdict> = {};
  const because: Record<string, string> = {};
  for (const s of parsed.seen ?? []) {
    // A slug the ledger has never heard of cannot be reconciled against
    // anything, so it is dropped rather than shown as a mystery card.
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
    unknown: (parsed.unknown ?? []).filter((u) => typeof u === "string").slice(0, 30),
    note: parsed.note ?? "",
  };
}
