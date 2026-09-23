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

import { isConvenience } from "./foods.ts";
import { ASSUMED_SRC, history } from "./history.ts";
import { type ListEntry, readList, removeFromList } from "./list.ts";
import { cookable, loadRecipes } from "./recipes.ts";
import { dispositionOf, onRunOut, readBook, skipped, unskip } from "./restock.ts";
import { fold, openPlans, readLog, slug } from "./store.ts";
import type { Category, Item } from "./types.ts";

export { ASSUMED_SRC, purchaseHistory, tripKey } from "./history.ts";

/** Why a line is on the list. The page renders these as its section headings. */
export type Reason = "asked" | "staple" | "meal" | "assumed";

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

/** How long an item assumed to be out stays in its own section of the list. */
export const ASSUMED_SHOWN_DAYS = 10;

/** How many "buy this and dinners open up" ideas the tray will ever show. */
const UNLOCK_CAP = 6;

/** Leftovers are food, not groceries. Nobody can buy last night's rice. */
export const isBuyable = (id: string, name = ""): boolean =>
  !id.startsWith("leftover-") && !/\bleftovers?\b/i.test(name);

/** A run-out older than this is history, not something to offer buying again. */
export const OFFER_WITHIN_DAYS = 21;

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

/** Out, or a human looked and said it was running low. */
const needsBuying = (i: Item): boolean => i.gone || i.level === "low";

export function shopping(account: string): Shopping {
  const events = readLog(account);
  const items = fold(account);
  const book = readBook(account);
  const written = readList(account).entries;
  const plans = openPlans(account, events);
  const hist = history(events);
  const { trips, shopsBy } = hist;
  const lastBought = new Map<string, string>();
  for (const [id, x] of hist.items) if (x.lastBought) lastBought.set(id, x.lastBought);
  // The newest write per item, to find the ones that are out only because the
  // kitchen assumed so.
  const lastWrite = new Map<string, { src: string | null | undefined; ts: string }>();
  for (const e of events) if (e.item) lastWrite.set(e.item, { src: e.src, ts: e.ts });
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
      if (!l.short || !isBuyable(l.item, l.name) || claimed.has(l.item)) continue;
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
  // Only proven staples reach the list by themselves (see `onRunOut`). A run-out
  // the house might want again is offered in the tray and in the next
  // follow-up; one it bought once and never cooked with is dropped. Items that
  // are out only because the kitchen assumed so get their own section, since
  // nobody has confirmed them.
  const staple: Line[] = [];
  const assumed: Line[] = [];
  const restockAsks: Suggestion[] = [];

  for (const it of Object.values(items)) {
    if (!needsBuying(it) || claimed.has(it.id)) continue;
    if (!isBuyable(it.id, it.name)) continue;
    const line = {
      key: it.id,
      name: it.name,
      amount: null,
      item: it.id,
      cat: it.cat,
      bought: age(it.id),
    };
    const last = lastWrite.get(it.id);
    if (last?.src === ASSUMED_SRC) {
      if (daysSince(last.ts)! <= ASSUMED_SHOWN_DAYS) {
        claimed.add(it.id);
        assumed.push({
          ...line,
          reason: "assumed",
          why: it.gone ? "probably out" : "probably low",
        });
      }
      continue;
    }
    if (skipped(book, it.id, trips, shopsBy)) {
      held.push({ name: it.name, why: "not this trip" });
      continue;
    }
    const seen = hist.items.get(it.id) ?? { trips: 0, mealUses: 0 };
    const fate = onRunOut(book, it.id, it.cat, seen);
    if (fate === "drop") {
      held.push({
        name: it.name,
        why:
          dispositionOf(book, it.id) === "never"
            ? "you said this was a one-off"
            : "bought once and never cooked with",
      });
      continue;
    }
    if (fate === "list") {
      // Claimed so the same item cannot also appear in the tray below.
      claimed.add(it.id);
      staple.push({ ...line, reason: "staple", why: it.gone ? "out" : "running low" });
      continue;
    }
    if ((daysSince(last?.ts) ?? 0) > OFFER_WITHIN_DAYS) {
      held.push({ name: it.name, why: "ran out a while ago" });
      continue;
    }
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
  // What they cook with most is what they most likely want back.
  const uses = (id: string) => hist.items.get(id)?.mealUses ?? 0;
  restockAsks.sort((a, b) => uses(b.item) - uses(a.item));

  /* ── 4. suggestions, which are not the list ────────────────────────────── */
  //
  // Scored against presence only. A dish is one item away when that item is not
  // in the house, never because a package holds fewer pieces than the recipe
  // counted — see `cookable` for why that comparison cannot be trusted.
  const unlocks = new Map<string, { name: string; recipes: string[] }>();
  for (const c of cookable(items, recipes)) {
    if (c.ready || c.missing.length > 2) continue;
    for (const m of c.missing) {
      if (!isBuyable(m.id, m.name) || claimed.has(m.id)) continue;
      // Only food this house has bought before: the catalog is shared, and a
      // suggestion built from somebody else's pantry is noise. Nor snacks:
      // buying chips so a dish "opens up" is not a suggestion anyone wants.
      const owned = items[m.id];
      if (!owned || isConvenience(owned)) continue;
      if (dispositionOf(book, m.id) === "never") continue;
      if (skipped(book, m.id, trips, shopsBy)) continue;
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
    }))
    .sort((a, b) => b.unlocks.length - a.unlocks.length || a.name.localeCompare(b.name));
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
        id: "assumed",
        title: "Assumed to be low/out:",
        lines: assumed,
        note: "Nobody confirmed these. Tick or delete any you still have.",
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
  // Restocks keep their most-cooked-first order; unlock ideas follow, by reach.
  const suggestions = [...restockAsks, ...unlockSuggestions.slice(0, UNLOCK_CAP)].sort(
    (a, b) =>
      order(a) - order(b) ||
      (a.kind === "unlock"
        ? b.unlocks.length - a.unlocks.length || a.name.localeCompare(b.name)
        : 0),
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
export const tripCount = (account: string): number => history(readLog(account)).trips;

export type AnswerTarget = { ok: true; id: string; name: string } | { ok: false; why: string };

/**
 * The item a shopping answer ("always", "never", "not this trip") is about.
 *
 * The answer arrives as whatever the model had to hand, which is usually the
 * name it read on the list rather than the id behind it, and slugging a name
 * does not rebuild an id another member's list gave a prefix to: "flour
 * tortillas" is `flour-tortillas`, the line was `sam-s-flour-tortillas`. The
 * answer was then filed under an id nothing uses, the line stayed on the list,
 * and the reply said it had gone.
 *
 * So an answer lands on something that exists or is refused. Candidates are what
 * the list and the tray are showing plus everything the ledger tracks; the first
 * rule that matches anything decides, and more than one match is a question back
 * rather than a pick.
 */
export function answerTarget(account: string, said: string): AnswerTarget {
  const names = new Map<string, string>();
  for (const [id, it] of Object.entries(fold(account))) names.set(id, it.name);
  const s = shopping(account);
  for (const l of s.lines) if (l.item) names.set(l.item, l.name);
  for (const x of s.suggestions) names.set(x.item, x.name);

  const raw = said.trim();
  if (!raw) return { ok: false, why: "The answer did not name an item." };
  const want = slug(raw);
  const lower = raw.toLowerCase();
  const rules: Array<(id: string, name: string) => boolean> = [
    (id) => id === raw,
    (id) => id === want,
    (_, name) => name.trim().toLowerCase() === lower,
    (id) => want.length > 0 && id.endsWith(`-${want}`),
  ];
  for (const rule of rules) {
    const hits = [...names].filter(([id, name]) => rule(id, name));
    if (hits.length === 1) return { ok: true, id: hits[0]![0], name: hits[0]![1] };
    if (hits.length > 1)
      return {
        ok: false,
        why: `"${raw}" could be ${hits.map(([id]) => id).join(", ")}. Answer with one of those.`,
      };
  }
  const words = want.split("-").filter((w) => w.length > 2);
  const near = [...names.keys()].filter((id) => words.some((w) => id.includes(w))).slice(0, 6);
  const close = near.length ? ` Close: ${near.join(", ")}.` : "";
  return {
    ok: false,
    why: `Nothing on the list, in the tray or in the ledger is "${raw}".${close}`,
  };
}

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
