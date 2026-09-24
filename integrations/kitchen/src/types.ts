/**
 * Shared types for the kitchen integration.
 *
 * On disk there is one append-only JSONL event log per household plus one
 * registry of households. Everything else (stock, spend, calories, the site)
 * is derived by folding the log on read.
 */

/** Storage locations an item can sit in. Display order follows this array. */
export const LOCATIONS = ["fridge", "freezer", "pantry", "counter", "spice rack"] as const;
export type Location = (typeof LOCATIONS)[number];

export const CATEGORIES = [
  "produce",
  "meat",
  "seafood",
  "dairy",
  "frozen",
  "bakery",
  "pantry",
  "condiment",
  "spice",
  "drink",
  "snack",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** For things nobody counts (spices, oils): a level instead of a fake quantity. */
export const LEVELS = ["full", "low", "out"] as const;
export type Level = (typeof LEVELS)[number];

export type EventOp =
  | "add"
  | "use"
  | "set"
  | "toss"
  | "plan"
  | "plan_done"
  | "plan_void"
  | "undo"
  | "note"
  /**
   * A receipt's printed total, keyed by `src` (the receipt id). Carries no item,
   * so the inventory fold skips it. The printed total is the number a person can
   * check, and keying by receipt stops a re-import from counting it twice.
   */
  | "trip";

export type ItemFields = {
  name?: string;
  cat?: Category;
  loc?: Location;
  unit?: string;
  level?: Level;
  expires?: string | null;
  aliases?: string[];
  opened?: boolean;
  /**
   * What this receipt line cost in total, never a per-unit rate. A receipt
   * prices the package while `qty` counts the stocking unit (a $1.46 dozen is
   * stocked as 12 eggs), so price and qty must never be multiplied.
   */
  price?: number;
  /** Store the item came from, e.g. "giant". */
  store?: string;
};

export type PlanLine = {
  item: string;
  name: string;
  qty: number | null;
  unit?: string | null;
  have?: number | null;
  short?: boolean;
};

export type Plan = {
  id: string;
  meal: string;
  when?: string | null;
  lines: PlanLine[];
  created: string;
  /** Computed at plan time and frozen, so a recap never re-derives history. */
  kcal?: number | null;
  /** The member session the meal was planned in, so its follow-up goes back there. */
  by?: string | null;
};

export type KitchenEvent = {
  ts: string;
  batch: string;
  op: EventOp;
  item?: string | null;
  qty?: number | null;
  unit?: string | null;
  fields?: ItemFields;
  why?: string | null;
  src?: string | null;
  plan?: Plan;
  plan_id?: string;
  batch_target?: string;
  /**
   * The site request this write answers. An idempotency token: a tap is marked
   * served after it is acted on, so a crash in between replays it, and this
   * stamp lets the replay see that the write already happened.
   */
  req?: string;
  /**
   * This `use` consumed some of the item, not all of it. A null-qty use
   * otherwise means "finished". Set by `useLines` for level-tracked items,
   * where a recipe's missing quantity means "a spoonful", not "the bottle".
   */
  some?: boolean;
};

export type Item = {
  id: string;
  name: string;
  cat: Category;
  loc: Location;
  qty: number | null;
  unit: string;
  level: Level | null;
  expires: string | null;
  opened: boolean;
  aliases: string[];
  added: string;
  updated: string;
  used_since_check: number;
  uses_since_check: number;
  use_unit: string | null;
  gone: boolean;
  price?: number;
  store?: string;
};

/**
 * A household: one kitchen's food plus the people who share it (see
 * `accounts.ts`). Everything after `members` is optional with a working
 * default, because no feature may require a setup step.
 */
export type Account = {
  name: string;
  created: string;
  members: string[];
  /**
   * Principal -> display name. The household is titled from these ("Sam and
   * Alex's Kitchen") rather than from `name`, which is usually an address.
   * Missing entries fall back to a formatted handle.
   */
  people?: Record<string, string>;
  note?: string | null;
  /** Weekly grocery target in dollars. Absent = infer from spend history. */
  budget?: number | null;
  /** Preferred stores, best-deal ranking prefers earlier entries on ties. */
  stores?: string[];
  diet?: {
    /** Daily kcal target. Absent = derive from logged intake, never invented. */
    kcal_target?: number | null;
    /** Foods this house does not eat, e.g. "pork". Enforced as a filter on dishes. */
    avoid?: string[];
    /** e.g. "high-protein", "low-carb". Advisory, used to rank meal picks. */
    style?: string | null;
  };
  schedule?: {
    /** "HH:MM" local. Absent = learned from when cook events actually land. */
    dinner?: string | null;
    breakfast?: string | null;
    lunch?: string | null;
    /** Weekday names the household batch-cooks on. */
    prep_days?: string[];
  };
  /**
   * Standing "text us what we are having" schedules (`schedules.ts`). Distinct
   * from `schedule`, which describes when the household eats. Every write goes
   * through `normalize`.
   */
  dinners?: import("./schedules.ts").Dinner[];
  site?: {
    /** Directory the site is rendered into and served from. */
    artifact?: string | null;
    url?: string | null;
    /** The `?key=` the kitchen host routes this household by (host.ts). */
    key?: string | null;
    /** The local port the host runs this household's share server on. */
    port?: number | null;
  };
  /**
   * The member session that receives unattended work, such as the morning
   * review. Site taps go to whoever tapped. Absent means the first member; never
   * a group, where a working turn would reach every phone.
   */
  wake?: string | null;
  /**
   * Title of the household's shared Apple Note; set it to adopt an existing
   * note. Edmund edits that note on screen, and the screen tools use the
   * title to tell this household's list from another's.
   */
  note_list?: string | null;
  /** Where the kitchen is, for the weather. No default: absent means no weather. */
  place?: { lat: number; lon: number; label?: string | null } | null;
  /**
   * How this household wants to be cooked for right now. Every field overrides
   * something the day would otherwise decide, and none is required.
   */
  prefs?: {
    /** Pinned vibe id. Null or absent = let the date and weather choose. */
    vibe?: string | null;
    /**
     * "prep" cooks once for several days, "ballout" ignores cost, "normal" is
     * neither. Shifts ranking; never filters.
     */
    mode?: "prep" | "normal" | "ballout" | null;
    /** Rough ceiling per dinner in dollars. Absent = no opinion. */
    per_meal?: number | null;
    /** Cooking methods this house does not want proposed, e.g. "grill". */
    avoid_methods?: string[];
  };
};

export type Registry = {
  version: number;
  tenants: Record<string, Account>;
};
