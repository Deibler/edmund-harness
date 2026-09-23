/**
 * The context every panel renders from, assembled once per render in `site.ts`
 * so all panels share one view of the household.
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
  /** What each dish sets up for tomorrow (compound pairs), keyed by dish. */
  leads: Map<string, Array<{ id: string; name: string; via: string[] }>>;
  /** What has to be cooked before each dish, keyed by dish. */
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

/** The dish's photo, falling back to its base recipe's, or null. */
export const mealPhoto = (a: Assets, id: string): string | null => {
  if (a.meals.has(id)) return `img/meals/${id}.jpg`;
  const base = baseIdOf({ id, base: null });
  return a.meals.has(base) ? `img/meals/${base}.jpg` : null;
};
