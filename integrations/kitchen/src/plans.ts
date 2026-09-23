/**
 * Consuming a cooked meal: the one write path for "we made it".
 *
 * A meal can be confirmed from a recipe page, the meals page or a chat. All of
 * them go through `confirmPlan`, so the same dinner is never deducted with two
 * different ingredient lists or charged twice.
 */

import { loadRecipes } from "./recipes.ts";
import { append, droppedBatches, live, openPlans, readLog, slug } from "./store.ts";
import type { KitchenEvent } from "./types.ts";

/** A plan line, or a recipe `needs` pair once it has been named. */
export type ConsumeLine = { item: string; qty: number | null };

/**
 * The leftovers a confirmed meal leaves in the fridge. Plans name the meal as
 * typed, so the recipe is matched by id, slugged name, or a logged name that
 * extends the recipe name on a slug boundary ("... over egg noodles, side salad").
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
 * The `use` events for a dish's ingredients.
 *
 * A null quantity means "all of it" on a counted item (one cucumber) but "some"
 * on a level-tracked staple (a spoon of ranch), so the latter is marked `some`.
 * The distinction is made here because the fold cannot tell a recipe's null
 * from a person saying "we finished the ketchup".
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
 * Consume a plan, add its leftovers and close it, all in one batch so a single
 * undo retracts the whole dinner.
 */
export function confirmPlan(
  account: string,
  id: string,
  p: { meal: string; lines: ConsumeLine[] },
  extra: { req?: string } = {},
): { batch: string; items: number; yields: number; summary: string } {
  // Leftovers are written so the second night of a pair is cookable; the
  // leftover sweep retires them after a few days.
  const yields = yieldsOf(account, p.meal);
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
 * The open plan for this dish, if any, matched by slug. Preferred over the
 * recipe's own list because it carries tonight's actual quantities.
 */
export function planFor(
  account: string,
  recipe: string,
  name?: string | null,
): { id: string; plan: { meal: string; lines: ConsumeLine[] } } | null {
  const want = new Set([recipe, slug(recipe), ...(name ? [slug(name)] : [])]);
  const hits = Object.entries(openPlans(account)).filter(([, p]) => want.has(slug(p.meal)));
  if (!hits.length) return null;
  // Several open plans can name one dish; the newest is what was last agreed.
  hits.sort((a, b) => String(b[1].created ?? "").localeCompare(String(a[1].created ?? "")));
  const [id, plan] = hits[0]!;
  return { id, plan };
}

/** How long a dish stays "already cooked" for the purposes of a repeat tap. */
const REPEAT_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Whether this dish was already consumed within `REPEAT_WINDOW_MS`. Catches a
 * person pressing "we made it" twice (two keys, one dinner), which the request
 * stamp cannot.
 */
export function cookedRecently(
  account: string,
  meal: string,
  now = Date.now(),
): { at: string } | null {
  const key = slug(meal);
  const evs = readLog(account);
  // Shared with the fold, so an undo that was itself undone is not a retraction.
  const undone = droppedBatches(evs);
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
