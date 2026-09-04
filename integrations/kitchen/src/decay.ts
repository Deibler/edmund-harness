/**
 * Food leaves the house without telling anyone.
 *
 * Every other part of this integration assumes the ledger hears about a change:
 * a receipt gets loaded, a meal gets logged, somebody says they finished the
 * milk. Real kitchens do not work that way. Leftovers get eaten standing at the
 * counter, a bag of greens turns and goes in the bin, half a cucumber is thrown
 * out during a clean-up nobody narrates. The log never learns, so the item sits
 * in stock forever and every downstream feature inherits the fiction: meals get
 * suggested from food that rotted a week ago, the shopping list omits things
 * the house actually needs, and the whole site slowly stops describing reality.
 *
 * So the ledger has to be able to conclude things on its own. The rule this
 * module encodes is the one a person would use looking in the fridge: if a
 * container of leftovers has been sitting untouched for the better part of a
 * week, it is not there any more, whatever the paperwork says.
 *
 * Two constraints shape every decision here.
 *
 * It must be quiet. A guess that demands confirmation is worse than no guess,
 * because it converts a silent inaccuracy into an interruption. Sweeps run
 * unattended and say nothing.
 *
 * It must be cheap to be wrong. Every sweep writes ONE batch, so undoing it is
 * one retraction and the items come back exactly as they were — the fold is the
 * only state, so there is nothing else to repair. Restocking works too: an
 * `add` after a bad cleanup simply puts the item back. Being reversible in one
 * move is what buys the right to guess at all.
 */

import { append, live, readLog } from "./store.ts";
import type { Item, KitchenEvent } from "./types.ts";

const DAY = 86_400_000;

/**
 * How long something lasts once it is in the house, by category, in days.
 *
 * Deliberately generous — these are "past any reasonable doubt" numbers, not
 * food-safety guidance. The cost of removing something that is still there is
 * a confused human; the cost of leaving something that is gone is a kitchen
 * that quietly stops being true. Both are real, so the thresholds sit far
 * enough out that anything crossing them is genuinely not in the fridge.
 */
const LIFE: Record<string, number> = {
  seafood: 4,
  meat: 6,
  produce: 14,
  dairy: 24,
  bakery: 10,
};

/**
 * Where produce is kept says more about its shelf life than what it is.
 *
 * The things that live on a counter or in a pantry are the keepers — onions,
 * garlic, citrus, whole squash, an uncut melon — and they last for a month or
 * more. Running them on the fridge-produce clock swept the entire onion bag and
 * every lemon at three weeks, which is exactly the kind of confident, wrong
 * cleanup that would make the whole idea unusable.
 */
const KEEPER_LOCATIONS = new Set(["counter", "pantry"]);
const KEEPER_LIFE = 45;

/** Days past a printed expiry date before it stops being plausible. */
const GRACE: Record<string, number> = {
  seafood: 2,
  meat: 3,
  dairy: 6,
  produce: 4,
  bakery: 5,
};

/**
 * Leftovers are the fastest-moving thing in any kitchen and the thing the log
 * is least likely to hear about, because eating them is not cooking and nobody
 * logs a reheat. Four days is the point past which a container is either eaten
 * or thrown out; it is essentially never still sitting there.
 */
const LEFTOVER_LIFE = 4;

/** Nothing in these categories is ever swept: it does not spoil on this timescale. */
const NEVER = new Set(["spice", "condiment", "pantry", "frozen", "drink", "snack", "other"]);

export type Stale = {
  item: Item;
  /** Plain-English why, shown to a human verbatim. */
  reason: string;
  /** Days past the threshold that triggered it. */
  over: number;
};

function lastTouched(item: Item): number {
  return new Date(item.updated || item.added).getTime();
}

/**
 * How long a human's "no, it's still here" outranks the machine.
 *
 * Without this, undo is theatre: the item goes back on the shelf and the next
 * morning's pass, seeing the same old timestamp, removes it again. Somebody
 * physically looking in the fridge is the best evidence that exists, so it
 * beats every threshold here — but not forever, because the food really will
 * be gone eventually and a permanent exemption is its own kind of wrong.
 */
const VINDICATION_DAYS = 14;

/**
 * Items a person has explicitly rescued from an automatic cleanup, and when.
 *
 * Found by walking undos back to the auto-cleanup batches they retract, which
 * is the only record that the guess was overruled.
 */
function vindicated(evs: KitchenEvent[]): Map<string, number> {
  const sweptIn = new Map<string, string[]>();
  for (const e of evs) {
    if (e.src !== "auto-cleanup" || !e.item) continue;
    (sweptIn.get(e.batch) ?? sweptIn.set(e.batch, []).get(e.batch)!).push(e.item);
  }
  const out = new Map<string, number>();
  for (const e of evs) {
    if (e.op !== "undo" || !e.batch_target) continue;
    for (const id of sweptIn.get(e.batch_target) ?? []) {
      out.set(id, Math.max(out.get(id) ?? 0, new Date(e.ts).getTime()));
    }
  }
  return out;
}

/**
 * Everything the ledger still believes is in the house but almost certainly is not.
 *
 * `now` is injectable so this is testable without waiting a week.
 */
export function staleItems(account: string, now = Date.now()): Stale[] {
  const out: Stale[] = [];
  const saved = vindicated(readLog(account));

  for (const item of live(account)) {
    // A level-tracked staple has no quantity to run out — half a bottle of oil
    // is still half a bottle in three weeks. Sweeping these would empty the
    // pantry on a timer.
    if (item.qty === null) continue;
    // Freezing stops the clock, whatever the category says.
    if (item.loc === "freezer") continue;
    // Somebody already told us this one was still here. Their answer stands.
    const rescued = saved.get(item.id);
    if (rescued !== undefined && (now - rescued) / DAY < VINDICATION_DAYS) continue;

    const idle = (now - Math.max(lastTouched(item), rescued ?? 0)) / DAY;
    // Anything touched in the last two days is being actively used. Nothing is
    // worth guessing about while somebody is clearly still eating it.
    if (idle < 2) continue;

    // Leftovers are checked BEFORE the never-sweep categories, because a
    // container of leftovers is almost always logged as "other" — three of the
    // four in this kitchen were — and "other" is on the never list. Ordering
    // these the other way round silently disabled the single most important
    // rule in the file: the one that notices a meal nobody logged eating.
    if (item.id.startsWith("leftover-")) {
      if (idle >= LEFTOVER_LIFE) {
        out.push({
          item,
          reason: `leftovers, untouched for ${Math.floor(idle)} days`,
          over: Math.floor(idle - LEFTOVER_LIFE),
        });
      }
      continue;
    }

    if (NEVER.has(item.cat)) continue;

    // Computed against `now` rather than through store's daysLeft, which reads
    // the wall clock. Using it here meant the dated branch silently ignored the
    // injected time: every simulated sweep reported nothing expired, no matter
    // how far forward the clock was pushed, and the test looked like a pass.
    if (item.expires) {
      const past = (now - new Date(`${item.expires}T00:00:00`).getTime()) / DAY;
      const grace = GRACE[item.cat] ?? 7;
      if (past >= grace) {
        out.push({
          item,
          reason: `${Math.floor(past)} days past its date`,
          over: Math.floor(past - grace),
        });
      }
      continue;
    }

    // No date on it. Fall back to how long the category survives at all, with
    // half again on top, because an undated guess deserves a wider margin than
    // a printed one.
    const keeper = item.cat === "produce" && KEEPER_LOCATIONS.has(item.loc);
    const life = keeper ? KEEPER_LIFE : LIFE[item.cat];
    if (life === undefined) continue;
    const limit = keeper ? life : life * 1.5;
    if (idle >= limit) {
      out.push({
        item,
        reason: `${item.cat}, in the ${item.loc} untouched for ${Math.floor(idle)} days`,
        over: Math.floor(idle - limit),
      });
    }
  }

  // Most overdue first: if a human reads only the top of this, it should be the
  // thing they are most certainly right about.
  return out.sort((a, b) => b.over - a.over);
}

export type Sweep = {
  /** The single batch every removal shares, and the handle for undoing it. */
  batch: string | null;
  removed: Array<{ id: string; name: string; reason: string }>;
};

/**
 * Retire everything that has clearly gone, in one retractable batch.
 *
 * Logged as `use` with src `auto-cleanup`, never `cooked`: this food was not
 * eaten as a meal, and letting a guess flow into the recap would put invented
 * pounds of meat and phantom dinners into the one place that is supposed to be
 * a record of what actually happened.
 */
export function sweepStale(account: string, opts: { dryRun?: boolean; now?: number } = {}): Sweep {
  const now = opts.now ?? Date.now();
  const stale = staleItems(account, now);
  if (!stale.length) return { batch: null, removed: [] };

  const removed = stale.map((s) => ({ id: s.item.id, name: s.item.name, reason: s.reason }));
  if (opts.dryRun) return { batch: null, removed };

  const batch = append(
    account,
    stale.map((s) => ({
      op: "use" as const,
      item: s.item.id,
      qty: null,
      unit: null,
      fields: {},
      why: `assumed gone: ${s.reason}`,
      src: "auto-cleanup",
    })),
  );
  return { batch, removed };
}

/**
 * The most recent automatic cleanup, for the "that was wrong, put it back" path.
 *
 * Only the last one is offered. An undo button for a sweep from three weeks ago
 * would restore food that is now certainly not there, which is the same error
 * in the other direction.
 */
export function lastSweep(
  account: string,
  events?: KitchenEvent[],
): { batch: string; at: string; items: Array<{ id: string; why: string }> } | null {
  const evs = events ?? readLog(account);
  let batch: string | null = null;
  let at = "";
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i]!.src === "auto-cleanup") {
      batch = evs[i]!.batch;
      at = evs[i]!.ts;
      break;
    }
  }
  if (!batch) return null;
  // A sweep that has already been undone must not be offered again, or the
  // button restores nothing and looks broken.
  const undone = evs.some((e) => e.op === "undo" && e.batch_target === batch);
  if (undone) return null;
  return {
    batch,
    at,
    items: evs
      .filter((e) => e.batch === batch && e.item)
      .map((e) => ({ id: e.item!, why: e.why ?? "" })),
  };
}
