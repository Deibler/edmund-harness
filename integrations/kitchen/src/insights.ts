/**
 * Everything derived from the log: meals, timing, intake, spend, waste, recap.
 *
 * The rule this file exists to honour: **no feature may require extra input.**
 * A household that only ever logs groceries and dinners gets calorie tracking,
 * a meal schedule, a spend picture and a year-in-review without ever answering
 * a question about any of them. So nothing here reads a settings form as a
 * prerequisite — settings only ever *override* a derived value.
 *
 * Everything is a fold over the same events the inventory is folded from, so
 * there is no second store to drift and no backfill to run. Add a year of
 * history and every number below is simply better.
 */

import { type MacroTotal, addTo, describeConfidence, emptyTotal } from "./nutrition.ts";
import { droppedBatches, fold, readLog } from "./store.ts";
import type { Item, KitchenEvent } from "./types.ts";

const DAY = 86400000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The calendar day a meal belongs to, in the kitchen's own timezone.
 *
 * `toISOString().slice(0, 10)` is UTC, and this house is UTC-4. Every dinner
 * after 8pm therefore filed itself under tomorrow: Sunday's 8:30pm dinner
 * appeared on Monday, Sunday showed zero meals, and the calorie chart put an
 * evening meal and the next morning's on the same bar. Meanwhile the mealtime
 * learner read `getHours()` in local time, so the two halves of this file
 * disagreed about what day it was.
 */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One meal that actually got eaten: a cook batch or a confirmed plan. */
export type Meal = {
  batch: string;
  name: string;
  at: Date;
  items: Array<{ id: string; qty: number | null }>;
  macros: MacroTotal;
};

function liveEvents(account: string): KitchenEvent[] {
  const evs = readLog(account);
  const dropped = droppedBatches(evs);
  return evs.filter((e) => e.op !== "undo" && !dropped.has(e.batch));
}

/**
 * Meals are reconstructed from consumption, not from anything anyone declared.
 *
 * A meal is a batch of `use` events with src="cooked" — which is exactly what
 * `cook` and a confirmed `plan` both write. Grouping by batch is what makes a
 * six-ingredient dinner one meal instead of six snacks.
 */
/**
 * The dish, without the occasion.
 *
 * Meals get logged with a trailing date for readability at the time of writing
 * ("dirty rice with blackened shrimp, Sun 8/9"). That is fine in a log line and
 * wrong everywhere the name is used as an IDENTITY: the same dinner cooked on
 * two nights became two different dishes, so every meal counted once and the
 * recap concluded the house had never repeated itself. The event keeps its
 * original `why`; only the derived name is normalised.
 */
export function mealName(why: string | null | undefined): string {
  const raw = (why ?? "").trim();
  if (!raw) return "unnamed meal";
  return (
    raw
      // ", Sun 8/9" / " - Sunday 8/9/26" / ", 8/9"
      .replace(
        /[,\-–]\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*$/i,
        "",
      )
      .replace(/[,\-–]\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*$/, "")
      // ", Sunday" on its own
      .replace(/[,\-–]\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*$/i, "")
      .trim() || raw
  );
}

export function meals(account: string, since?: Date): Meal[] {
  const evs = liveEvents(account);
  const items = fold(account, evs);
  const byBatch = new Map<string, Meal>();

  for (const e of evs) {
    if (e.op !== "use" || e.src !== "cooked" || !e.item) continue;
    const at = new Date(e.ts);
    if (since && at < since) continue;
    let m = byBatch.get(e.batch);
    if (!m) {
      m = { batch: e.batch, name: mealName(e.why), at, items: [], macros: emptyTotal() };
      byBatch.set(e.batch, m);
    }
    m.items.push({ id: e.item, qty: e.qty ?? null });
    addTo(m.macros, e.item, e.qty ?? null, items[e.item]?.cat, e.unit, items[e.item]?.unit);
  }
  return [...byBatch.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * When this household actually eats, learned from when meals get logged.
 *
 * The signal is logging time, not eating time. Those converge once people are
 * confirming meals as they cook them, but a backfilled week — a batch of
 * history entered in one afternoon — drags the median toward the afternoon it
 * was typed. So the threshold is deliberately high and `basis` says out loud
 * what the number is measuring, rather than presenting a confident dinner hour
 * built from data-entry timestamps.
 *
 * Returns null rather than a plausible default when history is thin. An
 * invented dinner time is indistinguishable from a real one on the page, which
 * is exactly the failure this whole system exists to prevent.
 */
export function learnedSchedule(account: string): {
  dinnerHour: number | null;
  prepDays: string[];
  mealsPerWeek: number | null;
  basis: string;
} {
  const ms = meals(account);
  if (ms.length < 8) {
    return {
      dinnerHour: null,
      prepDays: [],
      mealsPerWeek: null,
      basis: `only ${ms.length} meals logged; needs about 8 before a mealtime means anything`,
    };
  }
  const hours = ms.map((m) => m.at.getHours()).sort((a, b) => a - b);
  const dinnerHour = hours[Math.floor(hours.length / 2)]!;

  const byDay = new Map<number, number>();
  for (const m of ms) byDay.set(m.at.getDay(), (byDay.get(m.at.getDay()) ?? 0) + 1);
  // A prep day is one the household cooks on materially more than average.
  const avg = ms.length / 7;
  const prepDays = [...byDay.entries()]
    .filter(([, n]) => n > avg * 1.5)
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => WEEKDAYS[d]!);

  const span = (ms.at(-1)!.at.getTime() - ms[0]!.at.getTime()) / DAY;
  const mealsPerWeek = span >= 7 ? Math.round((ms.length / span) * 7 * 10) / 10 : null;
  return {
    dinnerHour,
    prepDays,
    mealsPerWeek,
    basis:
      `learned from when ${ms.length} meals were logged over ` +
      `${Math.max(1, Math.round(span))} days — logging time, not necessarily eating time`,
  };
}

export type DayIntake = { date: string; kcal: number; meals: number; macros: MacroTotal };

/** Calories per day, derived from cooked meals. Split across the household. */
export function intake(account: string, days = 14, splitBetween = 1): DayIntake[] {
  const since = new Date(Date.now() - days * DAY);
  const byDate = new Map<string, DayIntake>();
  for (const m of meals(account, since)) {
    const key = dayKey(m.at);
    let d = byDate.get(key);
    if (!d) {
      d = { date: key, kcal: 0, meals: 0, macros: emptyTotal() };
      byDate.set(key, d);
    }
    d.meals += 1;
    d.kcal += m.macros.kcal / splitBetween;
    d.macros.kcal += m.macros.kcal / splitBetween;
    d.macros.protein += m.macros.protein / splitBetween;
    d.macros.carb += m.macros.carb / splitBetween;
    d.macros.fat += m.macros.fat / splitBetween;
    d.macros.fromTable += m.macros.fromTable;
    d.macros.fromCategory += m.macros.fromCategory;
    d.macros.unknown += m.macros.unknown;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * A calorie target nobody had to type.
 *
 * If the account set one, that wins. Otherwise the household's own median day
 * is the only defensible reference point — it is what they actually eat, so it
 * makes "today is high" meaningful without pretending to know anyone's body.
 */
export function kcalTarget(
  account: string,
  setTarget?: number | null,
  splitBetween = 1,
): {
  target: number | null;
  source: string;
} {
  if (setTarget) return { target: setTarget, source: "set on the account" };
  const all = intake(account, 30, splitBetween);
  const days = all.filter((d) => d.kcal > 0);
  // A night of leftovers is a real day of eating that scores zero, because the
  // leftover item is deliberately zeroed in the nutrition table so the original
  // cook is not counted twice. Dropping those days silently made the median a
  // "median cook-from-scratch day" while calling itself a median day, biasing the
  // reference upward for exactly the households that eat leftovers most.
  const unmeasured = all.length - days.length;
  if (days.length < 5) return { target: null, source: "not enough logged days to infer one" };
  const sorted = days.map((d) => d.kcal).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return {
    target: Math.round(median / 10) * 10,
    source: `this household's own median day over ${days.length} logged days${
      unmeasured
        ? `, excluding ${unmeasured} leftovers-only day(s) that carry no countable calories`
        : ""
    }`,
  };
}

export type Spend = {
  total: number;
  byStore: Array<{ store: string; total: number; trips: number }>;
  trips: number;
  coverage: number;
  perWeek: number | null;
  /** Days actually covered by priced purchases — the denominator perWeek uses. */
  spanDays: number;
  /** Trips whose money is known, and trips seen at all. total covers the former. */
  pricedTrips: number;
  /** Receipts in the window with no total and no line prices, by name. */
  unpricedTrips: string[];
};

/**
 * Grocery spend.
 *
 * Money is accounted per TRIP, not per line. A trip's cost is its printed
 * total when one was logged, and only falls back to summing line prices when
 * it wasn't — the total is both more reliable (one number instead of forty
 * transcriptions) and immune to a receipt being imported twice, which has
 * already happened once here.
 *
 * `coverage` is the fraction of TRIPS whose money is known. It used to be the
 * fraction of priced item rows, which read as 16% while three of four real
 * receipts were missing entirely, and quietly summing the priced remainder
 * reported a month of groceries as $49.81. A trip with no money attached is
 * named in `unpricedTrips` rather than averaged over or ignored.
 */
export function spend(account: string, days = 90): Spend {
  const since = Date.now() - days * DAY;
  const live = liveEvents(account).filter((e) => new Date(e.ts).getTime() >= since);

  // Declared totals first: src is the receipt's identity, so two imports of one
  // receipt collapse to one trip here instead of doubling it.
  const declared = new Map<string, { total: number; store: string; ts: string }>();
  for (const e of live) {
    if (e.op !== "trip") continue;
    const key = e.src ?? e.batch;
    const t = e.fields?.price;
    if (typeof t !== "number") continue;
    declared.set(key, {
      total: t,
      store: e.fields?.store ?? storeFromSrc(e.src) ?? "unknown",
      ts: e.ts,
    });
  }

  // Then the item rows. Grouped by receipt AND DAY, not receipt alone: one
  // receipt imported twice in the same afternoon is one shopping trip, but the
  // same src reused across different days is genuinely several, and collapsing
  // those turned three weekly shops into a single $300 purchase with no span.
  const summed = new Map<
    string,
    { total: number; store: string; ts: string; lines: number; src: string | null }
  >();
  const seen = new Map<string, { store: string; ts: string; src: string | null }>();
  for (const e of live) {
    if (e.op !== "add") continue;
    const src = e.src ?? null;
    const key = src ? `${src}|${dayKey(new Date(e.ts))}` : e.batch;
    const store = e.fields?.store ?? storeFromSrc(src) ?? "unknown";
    if (!seen.has(key)) seen.set(key, { store, ts: e.ts, src });
    const p = e.fields?.price;
    if (typeof p !== "number") continue;
    // `price` is the line total, not a rate to multiply by qty: qty counts the
    // stocking unit (12 eggs) while a receipt prices the package (one dozen).
    // Multiplying turned a $1.46 dozen into $17.52 and overstated a trip by 79%.
    const s = summed.get(key) ?? { total: 0, store, ts: e.ts, lines: 0, src };
    s.total += p;
    s.lines += 1;
    summed.set(key, s);
  }

  let total = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  const stores = new Map<string, { total: number; trips: Set<string> }>();
  const unpricedTrips: string[] = [];
  let pricedTrips = 0;
  // A receipt has ONE printed total however many times it was imported, so once
  // a src has been paid for, none of its item groups may add to the bill again.
  const spentSrc = new Set<string>();

  const charge = (key: string, cost: number, store: string, ts: string) => {
    total += cost;
    pricedTrips += 1;
    const t = new Date(ts).getTime();
    if (t < first) first = t;
    if (t > last) last = t;
    const agg = stores.get(store) ?? { total: 0, trips: new Set<string>() };
    agg.total += cost;
    agg.trips.add(key);
    stores.set(store, agg);
  };

  for (const [key, meta] of seen) {
    const d = meta.src ? declared.get(meta.src) : undefined;
    if (d) {
      if (spentSrc.has(meta.src!)) continue;
      spentSrc.add(meta.src!);
      charge(key, d.total, d.store, meta.ts);
      continue;
    }
    const s = summed.get(key);
    if (!s || s.lines === 0) {
      if (meta.src?.startsWith("receipt:")) unpricedTrips.push(meta.src.slice("receipt:".length));
      continue;
    }
    charge(key, s.total, meta.store, meta.ts);
  }
  // A declared total for a receipt whose items were never loaded still spent money.
  for (const [src, d] of declared) {
    if (spentSrc.has(src)) continue;
    spentSrc.add(src);
    charge(src, d.total, d.store, d.ts);
  }

  // Defined as exactly what was charged plus what could not be: unioning the
  // two maps directly double counted every receipt, because their keys live in
  // different spaces ("src|day" against bare "src"), reporting four shops as
  // eight and halving the coverage figure sitting right beside them.
  const trips = pricedTrips + new Set(unpricedTrips).size;
  // Rate over the span the data actually covers, not over the window that was
  // asked for. Three weeks of receipts queried with days=90 used to be divided by
  // thirteen weeks, reporting a weekly grocery bill roughly a quarter of the real
  // one — and it looked more precise the longer the window, which is backwards.
  // Below a week there is no weekly rate to state, so say nothing rather than
  // annualise a single shop.
  const spanDays = pricedTrips ? Math.max(1, (last - first) / DAY) : 0;
  // Fencepost: N shopping days spanning D days cover N-1 gaps, but they FEED
  // N periods — the last shop buys the week after it, past the span it closes.
  // Dividing by the raw span therefore overstates the weekly bill by N/(N-1):
  // three weekly $100 shops span 14 days and read as $150/week. Scale the
  // denominator by that factor so each trip is credited with the stretch it
  // actually covers. Distinct DAYS, not batches — two receipts one afternoon is
  // one shopping day, and counting it as two invents a zero-length gap.
  const shopDays = new Set(
    [...seen.entries()]
      .filter(([k, m]) => (m.src && declared.has(m.src)) || summed.has(k))
      .map(([, m]) => dayKey(new Date(m.ts)))
      .concat(
        [...declared.entries()]
          .filter(([s]) => ![...seen.values()].some((m) => m.src === s))
          .map(([, d]) => dayKey(new Date(d.ts))),
      ),
  ).size;
  const coveredDays = shopDays > 1 ? (spanDays * shopDays) / (shopDays - 1) : 0;
  const perWeek =
    total > 0 && coveredDays >= 7 ? Math.round((total / (coveredDays / 7)) * 100) / 100 : null;
  return {
    total: Math.round(total * 100) / 100,
    byStore: [...stores.entries()]
      .map(([store, s]) => ({ store, total: Math.round(s.total * 100) / 100, trips: s.trips.size }))
      .sort((a, b) => b.total - a.total),
    trips,
    coverage: trips ? pricedTrips / trips : 0,
    perWeek,
    spanDays: Math.round(spanDays),
    pricedTrips,
    unpricedTrips: [...new Set(unpricedTrips)],
  };
}

function storeFromSrc(src?: string | null): string | null {
  const m = /^receipt:([a-z0-9-]+?)-\d{4}-\d{2}-\d{2}$/.exec(src ?? "");
  return m ? m[1]! : null;
}

export type Recap = {
  window: string;
  meals: number;
  distinctMeals: number;
  /** Pounds of meat and seafood actually eaten, counting only lb-denominated uses. */
  meatLbs: number;
  /** Meat uses that could not be weighed (a "1 pkg" is real but not a weight). */
  meatUsesUnweighed: number;
  /** Meals cooked from a previous meal's leftovers. */
  compoundMeals: number;
  /** Empty when nothing has genuinely repeated — a "most made" of 1 is noise. */
  topMeals: Array<{ name: string; times: number }>;
  topItems: Array<{ id: string; name: string; times: number }>;
  busiestDay: { day: string; meals: number } | null;
  longestStreak: { days: number; from: string; to: string } | null;
  tossed: Array<{ name: string; why: string | null }>;
  wasteRate: number;
  avgKcal: number | null;
  kcalConfidence: string;
  spend: Spend;
  newThings: Array<{ id: string; name: string; at: string }>;
  headline: string;
};

/**
 * The Spotify-Wrapped fold. Pure derivation, no new logging required.
 *
 * Everything here answers a question a person would actually ask out loud
 * ("what did we make most?", "what did we waste?"), because a stat nobody
 * would say aloud is filler.
 */
export function recap(account: string, days = 365, splitBetween = 1): Recap {
  const since = new Date(Date.now() - days * DAY);
  const ms = meals(account, since);
  const items = fold(account);
  const evs = liveEvents(account);

  const mealCounts = new Map<string, number>();
  for (const m of ms) mealCounts.set(m.name, (mealCounts.get(m.name) ?? 0) + 1);

  const itemCounts = new Map<string, number>();
  for (const m of ms)
    for (const i of m.items) itemCounts.set(i.id, (itemCounts.get(i.id) ?? 0) + 1);

  const byDay = new Map<string, number>();
  for (const m of ms) {
    const k = dayKey(m.at);
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
  }
  const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];

  // Longest run of consecutive days with at least one meal logged. Both sides are
  // "YYYY-MM-DD" parsed as UTC midnight, so the difference is exact whole days and
  // a daylight-saving boundary cannot make two adjacent days look non-adjacent.
  const dates = [...byDay.keys()].sort();
  let streak: Recap["longestStreak"] = null;
  let runStart = dates[0];
  let runLen = 0;
  let prev: string | null = null;
  for (const d of dates) {
    const consecutive = prev && new Date(d).getTime() - new Date(prev).getTime() === DAY;
    if (consecutive) runLen += 1;
    else {
      runStart = d;
      runLen = 1;
    }
    if (!streak || runLen > streak.days) streak = { days: runLen, from: runStart!, to: d };
    prev = d;
  }

  const tossed = evs
    .filter((e) => e.op === "toss" && new Date(e.ts) >= since && e.item)
    .map((e) => ({ name: items[e.item!]?.name ?? e.item!, why: e.why ?? null }));
  const purchased = new Set(
    evs.filter((e) => e.op === "add" && new Date(e.ts) >= since && e.item).map((e) => e.item!),
  ).size;
  // Both sides of the waste ratio have to be the same unit. It used to divide a
  // count of toss EVENTS by a count of DISTINCT items purchased, so throwing out
  // the same thing twice counted twice while buying it twice counted once — and
  // a household that restocks and bins one item repeatedly could print a waste
  // rate above 100%. Distinct things tossed over distinct things bought.
  const tossedDistinct = new Set(
    evs.filter((e) => e.op === "toss" && new Date(e.ts) >= since && e.item).map((e) => e.item!),
  ).size;

  const dayIntake = intake(account, days, splitBetween).filter((d) => d.kcal > 0);
  const avgKcal = dayIntake.length
    ? Math.round(dayIntake.reduce((s, d) => s + d.kcal, 0) / dayIntake.length)
    : null;
  const allMacros = emptyTotal();
  for (const m of ms) {
    allMacros.fromTable += m.macros.fromTable;
    allMacros.fromCategory += m.macros.fromCategory;
    allMacros.unknown += m.macros.unknown;
  }

  const firstSeen = new Map<string, string>();
  for (const e of evs) {
    if (e.op === "add" && e.item && !firstSeen.has(e.item)) firstSeen.set(e.item, e.ts);
  }
  const newThings = [...firstSeen.entries()]
    .filter(([, ts]) => new Date(ts) >= since)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, 8)
    // dayKey, not a slice of the ISO string: every timestamp here is stamped in
    // UTC, so after 8pm Eastern the first ten characters are tomorrow.
    .map(([id, at]) => ({ id, name: items[id]?.name ?? id, at: dayKey(new Date(at)) }));

  // Protein actually eaten, in pounds. Only `lb`-denominated uses count: a
  // "1 pkg" of chicken is a real use but an unknown weight, and converting it
  // with an assumed package size would put a fabricated number on a card that
  // reads as measured. Uses that cannot be weighed are reported separately.
  // Most meat is logged as "used it all" with no number, so a naive sum of
  // `qty` reports zero pounds for a house that plainly ate meat. But an item
  // stocked in POUNDS that gets finished consumed exactly what was on hand, and
  // what was on hand is right there in the add. So walk the log forward keeping
  // a running weight per lb-stocked item and attribute the finish to it.
  //
  // Anything stocked in pkg/ct/container stays unweighed and is reported as a
  // count instead. A package is a real use of an unknown weight, and assuming
  // a pound per pack would put an invented number on a card that reads measured.
  let meatLbs = 0;
  let meatUsesUnweighed = 0;
  const onHandLbs = new Map<string, number>();
  const isLb = (u?: string | null) => /^(lb|lbs|pound|pounds)$/i.test((u ?? "").trim());
  for (const e of evs) {
    if (!e.item) continue;
    const it = items[e.item];
    const lbStocked = isLb(e.unit) || isLb(it?.unit);
    if (e.op === "add" && lbStocked && typeof e.qty === "number") {
      onHandLbs.set(e.item, (onHandLbs.get(e.item) ?? 0) + e.qty);
      continue;
    }
    if (e.op !== "use" || e.src !== "cooked") continue;
    const cat = it?.cat;
    if (cat !== "meat" && cat !== "seafood") continue;

    const used =
      typeof e.qty === "number"
        ? lbStocked
          ? e.qty
          : null
        : lbStocked
          ? (onHandLbs.get(e.item) ?? null)
          : null;
    // Deplete regardless of the window, so a use inside the window is weighed
    // against a purchase that may have happened before it.
    if (lbStocked) {
      onHandLbs.set(e.item, Math.max(0, (onHandLbs.get(e.item) ?? 0) - (used ?? 0)));
    }
    if (new Date(e.ts) < since) continue;
    if (used && used > 0) meatLbs += used;
    else meatUsesUnweighed += 1;
  }

  // A compound meal is one cooked FROM something already cooked. The signal is
  // a consumed item the ledger itself calls a leftover, which is what makes
  // this countable at all rather than a label somebody has to remember to add.
  const compoundMeals = ms.filter((m) => m.items.some((i) => i.id.startsWith("leftover-"))).length;

  const top = [...mealCounts.entries()].sort((a, b) => b[1] - a[1]);
  // "The one you kept coming back to" is only true if they came back to it.
  // With everything at 1x the honest headline is variety, not a fake favourite.
  // No em-dashes in anything a person reads. House style, and this string is
  // rendered as the recap's headline rather than buried in a tool response.
  const headline = !top.length
    ? `Nothing cooked in this window yet. Log a dinner and the recap fills itself in.`
    : top[0]![1] > 1
      ? `${ms.length} meals cooked, and ${top[0]![0]} was the one you kept coming back to (${top[0]![1]} times).`
      : `${ms.length} meals cooked, and no two the same yet.`;

  return {
    window: `${days} days`,
    meals: ms.length,
    distinctMeals: mealCounts.size,
    meatLbs: Math.round(meatLbs * 10) / 10,
    meatUsesUnweighed,
    compoundMeals,
    // Only a genuine repeat. A "most made" of 1 is not a favourite, it is the
    // alphabetically-luckiest row in a list where everything ties, and printing
    // it as a chart-topper is the kind of stat that makes a recap feel fake.
    topMeals:
      top[0] && top[0][1] > 1
        ? top
            .filter(([, n]) => n > 1)
            .slice(0, 5)
            .map(([name, times]) => ({ name, times }))
        : [],
    topItems: [...itemCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, times]) => ({ id, name: items[id]?.name ?? id, times })),
    busiestDay: busiest ? { day: busiest[0], meals: busiest[1] } : null,
    longestStreak: streak,
    tossed,
    wasteRate: purchased ? Math.min(1, tossedDistinct / purchased) : 0,
    avgKcal,
    kcalConfidence: describeConfidence(allMacros),
    spend: spend(account, days),
    newThings,
    headline,
  };
}

/**
 * What the household needs to buy: things that ran out or were flagged low.
 *
 * Leftovers are excluded. A finished container of Tuesday's chicken is not a
 * grocery item, and putting "leftover creamy mushroom noodles" on a shopping
 * list is the kind of thing that makes people stop trusting the whole list.
 */
export function shoppingList(account: string): Array<{ id: string; name: string }> {
  return Object.values(fold(account))
    .filter((i) => (i.gone || i.level === "low") && !i.id.startsWith("leftover-"))
    .map((i) => ({ id: i.id, name: i.name }));
}

/** Items with a clock on them, soonest first. */
export function expiring(account: string, withinDays = 5): Array<Item & { days: number }> {
  const out: Array<Item & { days: number }> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const i of Object.values(fold(account))) {
    if (i.gone || !i.expires) continue;
    const d = Math.round((new Date(`${i.expires}T00:00:00`).getTime() - today.getTime()) / DAY);
    if (d <= withinDays) out.push({ ...i, days: d });
  }
  return out.sort((a, b) => a.days - b.days);
}
