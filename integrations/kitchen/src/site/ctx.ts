/**
 * What every panel is handed.
 *
 * One object rather than a dozen parameters, because the panels are siblings
 * that all need the same view of the household and threading each piece
 * through by hand is how two panels end up disagreeing about what is in stock.
 * Assembled once per render in `site.ts`.
 *
 * Moved out of `site.ts` on 2026-08-17 unedited.
 */

import type { Assets } from "../assets.ts";
import { type BuiltRecipe, baseIdOf } from "../cookbook.ts";
import type { PricePoint } from "../cost.ts";
import type { lastSweep } from "../decay.ts";
import type { ExploreSet } from "../explore.ts";
import type { MadeIndex } from "../made.ts";
import type { Mood } from "../mood.ts";
import type { ProfileState } from "../profile.ts";
import type { Cookable } from "../recipes.ts";
import type { Account, Item } from "../types.ts";

export type Ctx = {
  account: string;
  acct: Account;
  assets: Assets;
  items: Record<string, Item>;
  cook: Cookable[];
  book: BuiltRecipe[];
  prof: ProfileState;
  /** Last price paid per item, for costing a dish out of real receipts. */
  prices: Map<string, PricePoint>;
  /** The most recent automatic cleanup, if it has not been undone. */
  sweep: ReturnType<typeof lastSweep>;
  /** Every dish this household has logged cooking, for the "made before" badge. */
  made: MadeIndex;
  /**
   * Which dish leads into which, keyed both ways.
   *
   * `leads` is what a dish sets up for tomorrow, `needs` is what has to be
   * cooked before it. Both are on the card because the pair is only useful
   * BEFORE dinner, and it was previously only visible in a strip at the top
   * that had nothing to do with the dish you were actually looking at.
   */
  leads: Map<string, Array<{ id: string; name: string; via: string[] }>>;
  needsFirst: Map<string, Array<{ id: string; name: string; via: string[] }>>;
  /** Written variants hanging off a dish, for the diverging-arrows badge. */
  variantsOf: Map<string, Array<{ id: string; name: string; reason: string | null }>>;
  /** Halves of a pair somebody has said they are not doing, "pairId|leg". */
  skips: Map<string, "parent" | "child">;
  /** What kind of day it is, and therefore how the grid is ordered. */
  mood: Mood;
  /** Dishes deliberately unlike anything this house cooks. May be absent. */
  explore: ExploreSet | null;
};

export const mealPhoto = (a: Assets, id: string): string | null => {
  if (a.meals.has(id)) return `img/meals/${id}.jpg`;
  const base = baseIdOf({ id, base: null });
  return a.meals.has(base) ? `img/meals/${base}.jpg` : null;
};
