/**
 * What to buy, and why each line is there.
 *
 * The old list was one flat set of checkboxes fed by two rules — anything the
 * ledger no longer had, plus anything standing between the kitchen and a nearly
 * cookable dish — and it collapsed into noise within a week of real use. The
 * complaint that started this rewrite listed twenty four lines, of which eight
 * were wrong in three different ways, and the person reading it could not tell
 * which eight because every line looked identical.
 *
 * The rewrite is mostly about separation. A shopping list has exactly three
 * kinds of line and mixing them is what destroys it:
 *
 *   1. You are out of something this house keeps. Needs no explanation.
 *   2. You are cooking a specific meal and these are the gaps. The meal IS the
 *      explanation, and the line should disappear when the meal does.
 *   3. Everything else, which is a suggestion and must never be on the list.
 *
 * Suggestions are the whole problem. "Buy imitation crab legs and two dishes
 * open up" is a reasonable thing to say and a terrible thing to put on a list
 * somebody is holding in a supermarket, because a list is a set of commitments
 * and a suggestion is not one. Kept in their own tray they are useful; mixed
 * into the list they make every other line suspect.
 *
 * Nothing here writes. This is a fold over the ledger, the plans, the written
 * list and the restock book, so a list is never stale and never needs to be
 * regenerated or cleaned up.
 */

import { type ListEntry, readList, removeFromList } from "./list.ts";
import { cookable, loadRecipes } from "./recipes.ts";
import { autoRestocks, dispositionOf, readBook, skipped, unskip } from "./restock.ts";
import { fold, openPlans, readLog } from "./store.ts";
import type { Category, Item, KitchenEvent } from "./types.ts";

/** Why a line is on the list. The page renders these as its section headings. */
export type Reason = "asked" | "staple" | "meal";

export type Line = {
  /** Stable handle for ticking, editing and removal. */
  key: string;
  name: string;
  amount: string | null;
  /** Ledger slug when this maps to a tracked item; null for a free-text line. */
  item: string | null;
  cat: Category | null;
  reason: Reason;
  /** One clause a human can check, e.g. "for Thursday's chicken parm". */
  why: string;
  /** Days since this was last bought, when it has ever been bought. */
  bought?: number | null;
};

export type Suggestion = {
  key: string;
  name: string;
  item: string;
  cat: Category | null;
  /**
   * "restock" is "this ran out, do you want it again" and is answered once,
   * forever. "unlock" is "buying this opens up dinners" and is answered every
   * time, because it is a fresh decision rather than a standing preference.
   */
  kind: "restock" | "unlock";
  /** Recipe names this would make cookable. Empty for a plain restock ask. */
  unlocks: string[];
  why: string;
  bought?: number | null;
};

export type Group = {
  id: Reason;
  title: string;
  note: string;
  lines: Line[];
};

export type Shopping = {
  groups: Group[];
  /** Every line across every group, in display order. */
  lines: Line[];
  suggestions: Suggestion[];
  /**
   * Things deliberately kept off, with the reason. Surfaced because a list that
   * silently drops things is a list nobody can debug, and because "I already
   * bought that" is exactly the correction that has to be easy to make.
   */
  held: Array<{ name: string; why: string }>;
};

const DAY = 86400000;

/** How many "buy this and dinners open up" ideas the tray will ever show. */
const UNLOCK_CAP = 6;

/** Leftovers are food, not groceries. Nobody can buy last night's rice. */
export const isBuyable = (id: string): boolean => !id.startsWith("leftover-");

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

/**
 * When each item last came through the door, and how many trips there have been.
 *
 * Both keep the list honest about time: a line for something bought yesterday
 * should say so rather than look like news, and a "not this trip" dismissal has
 * to know which trip it meant.
 */
export function purchaseHistory(events: KitchenEvent[]) {
  const lastBought = new Map<string, string>();
  // Counted by BATCH, because a batch is one write and a receipt is loaded as
  // one write. Counting events instead would make a forty line receipt look
  // like forty shopping trips, which would expire every skip forty times over.
  const tripBatches = new Set<string>();
  for (const e of events) {
    if (e.op === "trip") tripBatches.add(e.batch);
    if (e.op !== "add" || !e.item) continue;
    lastBought.set(e.item, e.ts);
    tripBatches.add(e.batch);
  }
  return { lastBought, trips: tripBatches.size };
}

/** Out, or a human looked and said it was running low. */
const needsBuying = (i: Item): boolean => i.gone || i.level === "low";

export function shopping(account: string): Shopping {
  const events = readLog(account);
  const items = fold(account);
  const book = readBook(account);
  const written = readList(account).entries;
  const plans = openPlans(account, events);
  const { lastBought, trips } = purchaseHistory(events);
  const { recipes } = loadRecipes(account);

  const held: Array<{ name: string; why: string }> = [];
  const age = (id: string) => daysSince(lastBought.get(id));

  /* ── 1. lines somebody wrote down themselves ───────────────────────────── */
  //
  // First because they are the only lines nothing derived: a person typed them,
  // so nothing here gets to second-guess them or drop them for being redundant.
  const asked: Line[] = written.map((w: ListEntry) => ({
    key: w.key,
    name: w.name,
    amount: w.amount ?? null,
    item: w.item ?? null,
    cat: (w.cat as Category) ?? items[w.item ?? ""]?.cat ?? null,
    reason: "asked" as const,
    why: w.why || "you added this",
    bought: w.item ? age(w.item) : null,
  }));
  const claimed = new Set(asked.flatMap((a) => [a.key, a.item ?? ""]));

  /* ── 2. gaps in a meal somebody has actually committed to ──────────────── */
  //
  // An open plan is a decision, which is what separates this from the
  // suggestion tray: somebody said they were making this. The meal's name goes
  // on the line so it can be defended three days later, and the line leaves on
  // its own when the plan is cooked or called off.
  const meal: Line[] = [];
  for (const p of Object.values(plans)) {
    for (const l of p.lines) {
      if (!l.short || !isBuyable(l.item) || claimed.has(l.item)) continue;
      claimed.add(l.item);
      meal.push({
        key: l.item,
        name: l.name,
        amount: l.qty !== null ? `${l.qty}${l.unit ? ` ${l.unit}` : ""}` : null,
        item: l.item,
        cat: items[l.item]?.cat ?? null,
        reason: "meal",
        why: `for ${p.meal}`,
        bought: age(l.item),
      });
    }
  }

  /* ── 3. out of something this house keeps ──────────────────────────────── */
  //
  // The only derived lines allowed onto the list, and only because the house
  // has answered the question for that item: either explicitly, or by it being
  // in a category where running out is unambiguous. Everything else falls
  // through to the tray below.
  const staple: Line[] = [];
  const restockAsks: Suggestion[] = [];

  for (const it of Object.values(items)) {
    if (!needsBuying(it) || claimed.has(it.id)) continue;
    if (!isBuyable(it.id)) continue;
    if (dispositionOf(book, it.id) === "never") {
      held.push({ name: it.name, why: "you said this was a one-off" });
      continue;
    }
    if (skipped(book, it.id, trips)) {
      held.push({ name: it.name, why: "not this trip" });
      continue;
    }
    const line = {
      key: it.id,
      name: it.name,
      amount: null,
      item: it.id,
      cat: it.cat,
      bought: age(it.id),
    };
    if (autoRestocks(book, it.id, it.cat)) {
      // Claimed as well as pushed: something already on the list must not also
      // appear in the tray underneath it as a thing to consider buying. Salsa
      // showed up in both, which reads as two different opinions about one
      // item and is precisely the confusion this split exists to remove.
      claimed.add(it.id);
      staple.push({ ...line, reason: "staple", why: it.gone ? "out" : "running low" });
    } else {
      restockAsks.push({
        key: it.id,
        name: it.name,
        item: it.id,
        cat: it.cat,
        kind: "restock",
        unlocks: [],
        why: it.gone ? "ran out" : "running low",
        bought: age(it.id),
      });
    }
  }

  /* ── 4. suggestions, which are not the list ────────────────────────────── */
  //
  // Scored against presence only. A dish is one item away when that item is not
  // in the house, never because a package holds fewer pieces than the recipe
  // counted — see `cookable` for why that comparison cannot be trusted.
  const unlocks = new Map<string, { name: string; recipes: string[] }>();
  for (const c of cookable(items, recipes)) {
    if (c.ready || c.missing.length > 2) continue;
    for (const m of c.missing) {
      if (!isBuyable(m.id) || claimed.has(m.id)) continue;
      if (dispositionOf(book, m.id) === "never") continue;
      if (skipped(book, m.id, trips)) continue;
      const e = unlocks.get(m.id) ?? { name: m.name, recipes: [] };
      e.recipes.push(c.recipe.name);
      unlocks.set(m.id, e);
    }
  }
  const asking = new Set(restockAsks.map((s) => s.item));
  for (const s of restockAsks) {
    const u = unlocks.get(s.item);
    if (u) s.unlocks = u.recipes;
  }
  // Capped, and the cap is the point rather than a performance guard. Every
  // recipe in the shared catalog contributes its missing ingredients here, so
  // an uncapped tray is unbounded in exactly the case where it does the most
  // damage: a household that has just started and owns almost nothing, where it
  // fills with dozens of items from other people's recipes and reads as a
  // machine listing its catalog rather than a kitchen making a suggestion.
  const unlockSuggestions: Suggestion[] = [...unlocks.entries()]
    .filter(([id]) => !asking.has(id))
    .map(([id, u]) => ({
      key: id,
      name: u.name,
      item: id,
      cat: items[id]?.cat ?? null,
      kind: "unlock" as const,
      unlocks: u.recipes,
      why: `${u.recipes.length} dish${u.recipes.length === 1 ? "" : "es"} away`,
      bought: age(id),
      /** Owned before ranks above never-owned: a repeat buy is a safer bet. */
      known: Boolean(items[id]),
    }))
    .sort(
      (a, b) =>
        b.unlocks.length - a.unlocks.length ||
        Number(b.known) - Number(a.known) ||
        a.name.localeCompare(b.name),
    )
    .map(({ known: _known, ...s }) => s);
  const trimmed = Math.max(0, unlockSuggestions.length - UNLOCK_CAP);
  if (trimmed) {
    held.push({
      name: `${trimmed} more idea${trimmed === 1 ? "" : "s"}`,
      why: "would open up fewer dishes than the ones shown",
    });
  }

  const groups: Group[] = (
    [
      {
        id: "meal",
        title: "For a meal you planned",
        lines: meal,
        note: "These leave on their own when the meal is cooked or called off.",
      },
      {
        id: "staple",
        title: "Out of something you keep",
        lines: staple,
        note: "Ran out or a shelf check said running low.",
      },
      {
        id: "asked",
        title: "You added these",
        lines: asked,
        note: "Nothing here is derived. Yours to edit or remove.",
      },
    ] satisfies Group[]
  ).filter((g) => g.lines.length > 0);

  const order = (s: Suggestion) => (s.kind === "restock" ? 0 : 1);
  const suggestions = [...restockAsks, ...unlockSuggestions.slice(0, UNLOCK_CAP)].sort(
    (a, b) =>
      order(a) - order(b) || b.unlocks.length - a.unlocks.length || a.name.localeCompare(b.name),
  );

  return { groups, lines: groups.flatMap((g) => g.lines), suggestions, held };
}

/**
 * Settle the list against what actually came home.
 *
 * The receipt is ground truth and the list is a guess, so when they disagree
 * the list loses. This exists because of a specific observed failure that no
 * amount of list-quality work would have fixed: the household shopped from a
 * hand-written note in the shop, came back with a full car, and the site's list
 * still showed every line it had shown that morning. Nothing was ticked,
 * because nobody had the page open. A list that cannot be settled by anything
 * except somebody tapping twenty checkboxes is a list that goes stale the first
 * time it is ignored, and it only has to go stale once to stop being read.
 *
 * Derived lines settle themselves — buying broth makes broth present and it
 * leaves the list on the next fold. Only the WRITTEN lines need clearing, since
 * nothing else could know they were satisfied. Skips are cleared for the same
 * reason: "not this trip" is spent once the trip happens.
 *
 * Returns what was still outstanding, so a caller can say "eleven of the
 * fourteen things showed up" rather than silently deleting the difference.
 */
export const tripCount = (account: string): number => purchaseHistory(readLog(account)).trips;

export function settleAfterPurchase(
  account: string,
  bought: string[],
): { cleared: string[]; outstanding: Line[] } {
  const arrived = new Set(bought.filter(Boolean));
  if (!arrived.size) return { cleared: [], outstanding: shopping(account).lines };

  const before = readList(account).entries;
  const hit = before.filter((e) => arrived.has(e.item ?? "") || arrived.has(e.key));
  if (hit.length)
    removeFromList(
      account,
      hit.map((e) => e.key),
    );
  unskip(account, [...arrived]);

  return {
    cleared: hit.map((e) => e.name),
    outstanding: shopping(account).lines,
  };
}
