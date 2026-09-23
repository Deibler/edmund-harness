/**
 * Retiring leftovers nobody logged eating.
 *
 * Leftovers are the fastest-moving food in any kitchen and the one the ledger
 * is least likely to hear about: nobody logs a reheat. A container untouched
 * for four days has been eaten or thrown out, so the daily pass retires it
 * without asking.
 *
 * Everything else is judged with evidence (`evidence.ts`), reviewed by the
 * model and confirmed in a follow-up (`followups.ts`), because a clock alone
 * is wrong too often: onions outlive their "use by" by weeks and raw chicken is
 * usually frozen, not rotting.
 *
 * Each sweep is one batch, so one undo restores everything it took, and an
 * item somebody rescues is left alone for two weeks.
 */

import { append, live, readLog } from "./store.ts";
import type { Item, KitchenEvent } from "./types.ts";

const DAY = 86_400_000;

/** Days a leftover container survives untouched. */
const LEFTOVER_LIFE = 4;

/** How long a rescued item is exempt from sweeping. */
const VINDICATION_DAYS = 14;

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

/** Leftovers the ledger still lists that have almost certainly been eaten. */
export function staleItems(account: string, now = Date.now()): Stale[] {
  const out: Stale[] = [];
  const saved = vindicated(readLog(account));

  for (const item of live(account)) {
    if (!item.id.startsWith("leftover-") || item.loc === "freezer") continue;
    const rescued = saved.get(item.id);
    if (rescued !== undefined && (now - rescued) / DAY < VINDICATION_DAYS) continue;
    const idle = (now - Math.max(lastTouched(item), rescued ?? 0)) / DAY;
    if (idle >= LEFTOVER_LIFE) {
      out.push({
        item,
        reason: `leftovers, untouched for ${Math.floor(idle)} days`,
        over: Math.floor(idle - LEFTOVER_LIFE),
      });
    }
  }
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
