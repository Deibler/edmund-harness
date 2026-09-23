/**
 * What to buy, and why each line is there.
 *
 * A list holds commitments only, in four groups that are never mixed: gaps in a
 * meal somebody planned, staples that ran out, items assumed out because nobody
 * answered a follow-up, and lines somebody wrote. Everything else is a
 * suggestion and lives in a separate tray; mixed into the list, a suggestion
 * makes every other line suspect.
 *
 * Nothing here writes. The list is a fold over the ledger, open plans, the
 * written list and the restock book, so it is never stale.
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
   * "restock": this ran out, do you want it again. "unlock": buying this opens
   * up dishes, a fresh decision each time.
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
  /** Things deliberately kept off, with the reason, so an omission can be explained. */
  held: Array<{ name: string; why: string }>;
};

const DAY = 86400000;

/** How long an item assumed to be out stays in its own section of the list. */
export const ASSUMED_SHOWN_DAYS = 10;

/** How many "buy this and dinners open up" ideas the tray will ever show. */
const UNLOCK_CAP = 6;

/** Leftovers are food, not groceries. */
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
  // The newest write per item, to find items that are out only by assumption.
  const lastWrite = new Map<string, { src: string | null | undefined; ts: string }>();
  for (const e of events) if (e.item) lastWrite.set(e.item, { src: e.src, ts: e.ts });
  const { recipes } = loadRecipes(account);

  const held: Array<{ name: string; why: string }> = [];
  const age = (id: string) => daysSince(lastBought.get(id));

  /* ── 1. lines somebody wrote down: never second-guessed ─────────────────── */
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

  /* ── 2. gaps in an open plan: they leave when the plan is settled ──────── */
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

  /* ── 3. run-outs ────────────────────────────────────────────────────────── */
  //
  // Proven staples are listed (`onRunOut`), other recent run-outs are offered in
  // the tray, one-offs never cooked with are dropped. Items out only by
  // assumption get their own section, since nobody confirmed them.
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
      claimed.add(it.id); // so it cannot also appear in the tray
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

  /* ── 4. unlock suggestions: the tray, not the list ─────────────────────── */
  //
  // Scored on presence only, like `cookable`.
  const unlocks = new Map<string, { name: string; recipes: string[] }>();
  for (const c of cookable(items, recipes)) {
    if (c.ready || c.missing.length > 2) continue;
    for (const m of c.missing) {
      if (!isBuyable(m.id, m.name) || claimed.has(m.id)) continue;
      // Only food this house has bought before (the catalog is shared), and
      // never snacks.
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
  // Capped at UNLOCK_CAP so the tray reads as a suggestion, not a catalog dump.
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

/** Shopping trips this kitchen has seen; what spends a "not this trip". */
export const tripCount = (account: string): number => history(readLog(account)).trips;

export type AnswerTarget = { ok: true; id: string; name: string } | { ok: false; why: string };

/**
 * The item a shopping answer ("always", "never", "not this trip") is about.
 *
 * The model usually answers with the name it read, which may not slug to the id
 * (a member's line can carry a prefix: `sam-s-flour-tortillas`). Candidates are
 * the list, the tray and the ledger; rules run narrowest first (id, slug, name,
 * then a unique prefixed ending). No match or several matches is refused.
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

/**
 * Settle the list against what came home. The receipt is ground truth: written
 * lines it satisfies are removed and "not this trip" skips on those items end.
 * Derived lines settle themselves on the next fold. Returns what is still
 * outstanding so the caller can report the difference.
 */
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
