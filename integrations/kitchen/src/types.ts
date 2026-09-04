/**
 * Shared shapes for the kitchen integration.
 *
 * On disk this is an append-only JSONL log per household plus one registry,
 * and nothing else is a source of truth: every derived thing — stock, spend,
 * calories, the recap, the site — is a fold over those events, recomputed on
 * read. A second store would be a second thing to keep right.
 *
 * A Python implementation of the same formats shipped alongside this until
 * 2026-08-17 and was removed. Two engines against one file was survivable
 * because an event is just a JSON object, but it meant every rule existed
 * twice and could drift.
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

/** Level is for things nobody counts. "0.7 jars of paprika" is a lie with a decimal point. */
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
   * What THIS LINE cost — the money that left, not a per-unit rate. A receipt
   * prices the package while `qty` counts the stocking unit (a $1.46 dozen
   * stocked as 12 eggs), so the two must never be multiplied. Line totals also
   * sum to the printed receipt total, which is the only way to check a
   * transcription. Unit prices for comparing stores live in the price book.
   * Never guessed here.
   */
  price?: number;
  /** Store the item came from, e.g. "giant". Enables per-store spend stats. */
  store?: string;
};

/**
 * A shopping trip's PRINTED total, logged as its own fact.
 *
 * Carries no `item`, so the inventory fold skips it — this is money, not food.
 *
 * It exists because line prices are the weaker number. Three of this
 * household's four receipts were loaded before per-item prices were captured
 * at all, so summing lines reported the one priced trip ($49.81) as the entire
 * grocery bill for the month while $178 of real receipts sat in the log with
 * their items but not their money. Line prices also depend on transcribing
 * every line correctly; the printed total is one number off the bottom of the
 * paper and it is the one a human can check.
 *
 * Keyed by `src` (the receipt id) rather than by batch, because a receipt can
 * be loaded more than once — this one was, twenty-six minutes apart — and a
 * total that is attached to the trip cannot be double counted by a second
 * import the way summed lines can.
 */

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
  /** Derived at plan time and frozen, so a recap never re-guesses history. */
  kcal?: number | null;
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
   * The site request this write answers, when it answers one.
   *
   * An idempotency token, not bookkeeping. The minute pass marks a tap served
   * AFTER acting on it, so a crash in that window leaves the tap unserved and
   * the next pass replays it — which for a "we cooked this" means taking the
   * same dinner off the shelves twice. Stamping the request key into the events
   * makes the replay detectable in the one place that cannot be lost: the log
   * the write itself went into.
   */
  req?: string;
  /**
   * This `use` consumed SOME of the item, not all of it.
   *
   * `qty: null` on a use normally means "it is finished" — that is what a
   * person means by "we used up the milk", and what a shelf check means when
   * somebody looks at an empty spot. A recipe means something else entirely by
   * a missing quantity: nobody wrote down how much ranch goes in a wrap,
   * because nobody has ever counted the bottle. Reading the second as the first
   * emptied real condiments off real shelves for dishes that spend a spoonful.
   *
   * Set only by `useLines` in plans.ts, and only when the item is level-tracked
   * — where "all of it" was never a quantity anybody knew.
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
 * A household. The unit of isolation is one kitchen's food plus the people who
 * share it, not one person — see `accounts.ts` for the full reasoning.
 * Everything past `members` is optional and has a working default,
 * because the product rule is that no feature may require a setup form.
 */
export type Account = {
  name: string;
  created: string;
  members: string[];
  /**
   * principal -> the person's name.
   *
   * The household is titled from these ("Sam and Alex's Kitchen") rather
   * than from `name`, which is a street address and belongs on an envelope, not
   * above a fridge. Absent entries fall back to a formatted handle, so this is
   * an override and never a setup step.
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
    /** Free-text constraints the planner must respect, e.g. "no pork". */
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
   * Standing "text us what we are having" schedules. See `schedules.ts`.
   *
   * Distinct from `schedule` above, which is a description of when this
   * household tends to eat and is learned rather than set. These are explicit
   * instructions with recipients attached, so they live as their own list and
   * every write goes through `normalize`.
   */
  dinners?: import("./schedules.ts").Dinner[];
  site?: {
    /** instant-share artifact dir that serves this account's site. */
    artifact?: string | null;
    url?: string | null;
  };
  /**
   * Title of the Apple Note this household's list is written into.
   *
   * Also settable so a note somebody already made and shared can be adopted
   * rather than replaced. A default is used when nobody has said.
   */
  note_list?: string | null;
  /**
   * The note's own address on icloud.com, learned the first time it is opened.
   *
   * Worth persisting because finding a note by TITLE means driving a virtualised
   * list, and that list recycles its DOM nodes: stale rows keep old titles, so a
   * click can land on a different note than the one matched. That actually
   * happened and read one note's participants as another's. With this stored,
   * every later run navigates straight to the note and the whole class of bug
   * stops existing.
   */
  note_url?: string | null;
  /** The share link, which is what actually gets sent to a person. */
  note_link?: string | null;
  /**
   * Where the kitchen is, for the one signal that cannot be computed from a
   * calendar: the weather. Absent means the page simply never mentions it.
   * There is no default coordinate, because a default coordinate is an invented
   * fact and this integration does not ship those.
   */
  place?: { lat: number; lon: number; label?: string | null } | null;
  /**
   * How this household wants to be cooked for right now.
   *
   * Every field is an override of something the day would otherwise decide on
   * its own, which is the only shape a preference is allowed to take here: the
   * page has to work for somebody who never opens settings, so nothing may
   * REQUIRE an answer. Setting one is a way of saying "no, this week I want
   * that", not a setup step.
   */
  prefs?: {
    /** Pinned vibe id. Null or absent = let the date and weather choose. */
    vibe?: string | null;
    /**
     * "prep" cooks once and eats it for days, "ballout" is the weekend where
     * cost stops mattering, "normal" is neither. Shifts ranking, never filters:
     * a preference that hides food is a preference that gets turned off.
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
