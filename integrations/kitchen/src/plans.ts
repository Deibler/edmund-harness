/**
 * Taking food off the shelves.
 *
 * Every path that consumes a meal goes through this module, and that is the
 * whole point of it existing. "We made it" can be pressed on a recipe page, a
 * plan can be confirmed on the meals page, and I can confirm one from a chat —
 * three surfaces asserting ONE fact about ONE dinner. When each surface owned
 * its own copy of the arithmetic they drifted apart, and on 2026-08-17 that
 * drift ate a real evening: a tap deducted a different ingredient list than the
 * one that got cooked, left the plan open, and stood ready to charge the same
 * dinner a second time the moment anybody answered the check-in.
 *
 * So: one write path, and the interesting decisions live here where they can be
 * read in one place.
 */

import { loadRecipes } from "./recipes.ts";
import { append, live, openPlans, readLog, slug } from "./store.ts";
import type { KitchenEvent } from "./types.ts";

/** A plan line, or a recipe `needs` pair once it has been named. */
export type ConsumeLine = { item: string; qty: number | null };

/**
 * What a confirmed meal leaves in the fridge.
 *
 * Plans record the meal by the name somebody typed, not by recipe id, so the
 * join back to the catalog is the same fuzzy one the history uses: the id, the
 * slugged display name, or a logged name that EXTENDS the recipe name on a slug
 * boundary ("beef and onion gravy over egg noodles, side salad").
 */
export function yieldsOf(account: string, meal: string): Array<[string, number | null]> {
  const { recipes } = loadRecipes(account);
  const key = slug(meal);
  const hit =
    recipes.find((r) => r.id === key || slug(r.name) === key) ??
    recipes.find((r) => (r.yields?.length ?? 0) > 0 && key.startsWith(`${slug(r.name)}-`));
  return hit?.yields ?? [];
}

/**
 * Turn what a dish needs into what actually comes off the shelves.
 *
 * The subtle one. A `null` quantity means two completely different things
 * depending on what it is attached to, and collapsing them is what emptied a
 * bottle of chipotle ranch for a recipe that spends a tablespoon of it.
 *
 *   - On a COUNTED item, null means "use up what is there". One cucumber, one
 *     package of thighs. That reading is right and is left alone.
 *   - On a LEVEL-TRACKED staple — oil, ranch, salt, anything nobody has ever
 *     counted — null cannot mean that, because nothing ever knew how much was
 *     in the bottle. The only honest reading is "this dish used some", so the
 *     event is marked `some` and the fold accrues it instead of declaring the
 *     bottle empty.
 *
 * The distinction has to be drawn HERE rather than in the fold, because the
 * fold sees an identical event when a person says "we finished the ketchup",
 * and that one really does mean gone.
 */
export function useLines(
  account: string,
  lines: ConsumeLine[],
  why: string,
  extra: { src?: string; req?: string } = {},
): Array<Partial<KitchenEvent> & { op: "use"; item: string }> {
  const stock = Object.fromEntries(live(account).map((i) => [i.id, i]));
  return lines.map((l) => {
    const it = stock[l.item];
    const unknownAmount = l.qty === null || l.qty === undefined;
    const levelTracked = !!it && it.qty === null;
    return {
      op: "use" as const,
      item: l.item,
      qty: l.qty ?? null,
      fields: {},
      why,
      src: extra.src ?? "cooked",
      ...(extra.req ? { req: extra.req } : {}),
      ...(unknownAmount && levelTracked ? { some: true as const } : {}),
    };
  });
}

/**
 * Consume a plan, leave its leftovers, and close it.
 *
 * Shared rather than inlined because the same dinner can be confirmed from
 * three different places. When only the meals page ran this, confirming from a
 * recipe page deducted a second, differently-derived list and left the plan
 * OPEN, and confirming from a chat quietly dropped the leftovers entirely —
 * the second night of a batch cook simply never made it into the fridge.
 */
export function confirmPlan(
  account: string,
  id: string,
  p: { meal: string; lines: ConsumeLine[] },
  extra: { req?: string } = {},
): { batch: string; items: number; yields: number; summary: string } {
  // Cooking the first half of a pair actually puts the leftovers in the fridge,
  // so the ledger says so. Without this the second night was permanently
  // hypothetical: the site would keep offering "fried rice from last night"
  // while insisting there was no rice, because nothing ever wrote the rice
  // down. The decay engine retires these on its own after four days, which is
  // what stops them accumulating.
  const yields = yieldsOf(account, p.meal);
  // One batch, so the whole dinner — what it ate, what it left, and the fact
  // that it happened — retracts as a single honest unit.
  const batch = append(account, [
    ...useLines(account, p.lines, p.meal, extra),
    ...yields.map(([s]) => ({
      op: "add" as const,
      item: s,
      qty: 1,
      unit: "container",
      fields: {
        name: `Leftover ${s.replace(/^leftover-/, "").replace(/-/g, " ")}`,
        cat: "other" as const,
        loc: "fridge" as const,
      },
      why: `from ${p.meal}`,
      src: "cooked",
      ...(extra.req ? { req: extra.req } : {}),
    })),
    {
      op: "plan_done" as const,
      item: null,
      plan_id: id,
      why: p.meal,
      src: "cooked",
      ...(extra.req ? { req: extra.req } : {}),
    },
  ]);
  return {
    batch,
    items: p.lines.length,
    yields: yields.length,
    summary: `${p.lines.length} items consumed${yields.length ? `, ${yields.length} leftover(s) into the fridge` : ""}`,
  };
}

/**
 * The plan that is already open for this dish, if there is one.
 *
 * Plans record the meal by name and a page knows it by recipe id, so the join
 * is the same slug comparison `yieldsOf` uses. Matching matters more than it
 * looks: the plan carries the quantities somebody actually agreed to for
 * TONIGHT — half a package of thighs rather than the whole one — while any
 * ingredient list reconstructed from a recipe carries the general case.
 */
export function planFor(
  account: string,
  recipe: string,
  name?: string | null,
): { id: string; plan: { meal: string; lines: ConsumeLine[] } } | null {
  const want = new Set([recipe, slug(recipe), ...(name ? [slug(name)] : [])]);
  const hits = Object.entries(openPlans(account)).filter(([, p]) => want.has(slug(p.meal)));
  if (!hits.length) return null;
  // Two open plans can name the same dish — a plan re-scoped mid-afternoon, or
  // one restored by an undo. Taking whichever the object happened to yield first
  // meant the quantities that got consumed depended on insertion order. The
  // NEWEST is the one somebody most recently agreed to, so it wins.
  hits.sort((a, b) => String(b[1].created ?? "").localeCompare(String(a[1].created ?? "")));
  const [id, plan] = hits[0]!;
  return { id, plan };
}

/** How long a dish stays "already cooked" for the purposes of a repeat tap. */
const REPEAT_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Was this dish already taken off the shelves in the last few hours?
 *
 * The request-key stamp catches a REPLAY of one tap. It cannot catch a person
 * tapping "we made it" twice — two genuine taps, two different keys, one
 * dinner — and that is the likelier story, because the button gives no visible
 * receipt on the page and a second press is the normal human response to that.
 * Once the first tap has closed the plan, the second finds nothing open and
 * would happily deduct a whole second dinner from a reconstructed list.
 *
 * Six hours is chosen so that lunch and dinner of the same dish on the same day
 * still both count, while a double tap never does.
 */
export function cookedRecently(
  account: string,
  meal: string,
  now = Date.now(),
): { at: string } | null {
  const key = slug(meal);
  const evs = readLog(account);
  const undone = new Set(
    evs.filter((e) => e.op === "undo" && e.batch_target).map((e) => e.batch_target!),
  );
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]!;
    if (e.op !== "use" || e.src !== "cooked" || !e.why) continue;
    if (undone.has(e.batch)) continue;
    if (slug(e.why) !== key) continue;
    const at = Date.parse(e.ts);
    if (!Number.isFinite(at) || now - at > REPEAT_WINDOW_MS) return null;
    return { at: e.ts };
  }
  return null;
}
