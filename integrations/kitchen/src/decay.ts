/**
 * Retiring leftovers nobody logged eating.
 *
 * Nobody logs a reheat, so a leftover container untouched for four days is
 * assumed eaten or thrown out and the daily pass retires it without asking.
 * Everything else is judged from evidence (`evidence.ts`) and confirmed in a
 * follow-up (`followups.ts`); a clock alone is wrong too often for that.
 *
 * Each sweep is one batch, so one undo restores everything it took, and an
 * item somebody rescues is exempt for two weeks.
 */

import { append, droppedBatches, live, readLog } from "./store.ts";
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
 * Items a person rescued from an automatic cleanup (an undo of its batch), and
 * when. A rescue that was itself undone rescued nothing.
 */
function vindicated(evs: KitchenEvent[]): Map<string, number> {
  const dropped = droppedBatches(evs);
  const sweptIn = new Map<string, string[]>();
  for (const e of evs) {
    if (e.src !== "auto-cleanup" || !e.item) continue;
    (sweptIn.get(e.batch) ?? sweptIn.set(e.batch, []).get(e.batch)!).push(e.item);
  }
  const out = new Map<string, number>();
  for (const e of evs) {
    if (e.op !== "undo" || !e.batch_target || dropped.has(e.batch)) continue;
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
 * Retire every stale leftover in one retractable batch. Logged as `use` with
 * src `auto-cleanup`, never `cooked`, so a guess never reaches the meal recap.
 */
export function sweepStale(account: string, opts: { now?: number } = {}): Sweep {
  const now = opts.now ?? Date.now();
  const stale = staleItems(account, now);
  if (!stale.length) return { batch: null, removed: [] };

  const removed = stale.map((s) => ({ id: s.item.id, name: s.item.name, reason: s.reason }));
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
 * The most recent automatic cleanup, for the site's "put it back" button. Only
 * the last one is offered: undoing an old sweep would restore food that is
 * certainly gone by now.
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
  // An undone sweep is not offered again; the button would restore nothing.
  // Shared with the fold, so a put-back that was itself undone offers it again.
  if (droppedBatches(evs).has(batch)) return null;
  return {
    batch,
    at,
    items: evs
      .filter((e) => e.batch === batch && e.item)
      .map((e) => ({ id: e.item!, why: e.why ?? "" })),
  };
}
