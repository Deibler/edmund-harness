/**
 * Turning a judgement about an item into the right kind of write.
 *
 * Two sources, handled differently on purpose:
 *
 * - Reasoned (the morning review): the model's inference from evidence. A
 *   "frozen" verdict is written, because it only moves the item. "Low" and
 *   "gone" are held as suspicions and raised in the next follow-up, because an
 *   inference should not empty a shelf nobody has looked at.
 * - Told (a person said so in chat): the best evidence there is. Written at
 *   once, and any pending suspicion about the item is dropped.
 */

import { clearSuspects, markReviewed, suspect } from "./followups.ts";
import { REASONED_SRC } from "./history.ts";
import { append, fold, match } from "./store.ts";
import type { Item, KitchenEvent } from "./types.ts";

export const VERDICTS = ["here", "frozen", "low", "gone"] as const;
export type ItemVerdict = (typeof VERDICTS)[number];

/** Stamped on writes that record what a person said about their kitchen. */
export const TOLD_SRC = "told";

export type VerdictInput = { item: string; verdict: ItemVerdict; reason?: string | null };

export type AssessResult = {
  /** One line per verdict applied, for the tool's answer. */
  said: string[];
  /** Items that could not be resolved, with why. */
  refused: string[];
  batch: string | null;
};

/**
 * The write for a person saying something is here after all, or null when the
 * ledger already agrees (present, not low, not counted short of `qty`).
 *
 * It clears whatever made the kitchen think otherwise, out or low, assumed or
 * not, so the item leaves the list. Nothing arrived, so it is never a purchase:
 * the caller's `src` must not be a trip source. The chat verdict, the site's
 * "I already have this" and a tick under "Assumed to be low/out:" all come
 * through here, so they cannot disagree.
 */
export function stillHere(
  it: Item,
  opts: { why: string; src: string; qty?: number | null },
): Partial<KitchenEvent> | null {
  const { why, src } = opts;
  const want = opts.qty ?? null;
  // Finished, so only an add brings it back; with no count it is uncounted,
  // never an invented number.
  if (it.gone) return { op: "add", item: it.id, qty: want, fields: {}, why, src };
  const short = want !== null && typeof it.qty === "number" && it.qty < want;
  const low = it.level === "low" || it.level === "out";
  if (!short && !low) return null;
  return {
    op: "set",
    item: it.id,
    ...(short ? { qty: want } : {}),
    fields: low ? { level: "full" } : {},
    why,
    src,
  };
}

function resolve(items: Record<string, Item>, said: string): Item | string {
  const m = match(said, items);
  const hits = m.exact;
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) return `"${said}" is ambiguous: ${hits.map((h) => h.id).join(", ")}`;
  const near = m.near.slice(0, 3).map((h) => h.id);
  return `nothing is called "${said}"${near.length ? `; close: ${near.join(", ")}` : ""}`;
}

export function applyVerdicts(
  account: string,
  verdicts: VerdictInput[],
  opts: { told: boolean; now?: number },
): AssessResult {
  const now = opts.now ?? Date.now();
  const items = fold(account);
  const out: AssessResult = { said: [], refused: [], batch: null };
  const writes: Partial<KitchenEvent>[] = [];
  const suspicions: Parameters<typeof suspect>[1] = [];
  const settled: string[] = [];
  const src = opts.told ? TOLD_SRC : REASONED_SRC;

  for (const v of verdicts) {
    const found = resolve(items, v.item);
    if (typeof found === "string") {
      out.refused.push(found);
      continue;
    }
    const it = found;
    const why = v.reason?.trim() || (opts.told ? "they said so" : "reasoned from history");
    settled.push(it.id);

    if (v.verdict === "frozen") {
      writes.push({ op: "set", item: it.id, fields: { loc: "freezer" }, why, src });
      out.said.push(`${it.name}: moved to the freezer`);
      continue;
    }
    if (!opts.told) {
      if (v.verdict === "here") {
        out.said.push(`${it.name}: still here`);
        continue;
      }
      suspicions.push({ id: it.id, name: it.name, verdict: v.verdict, reason: why });
      out.said.push(`${it.name}: probably ${v.verdict}, will ask in the next follow-up`);
      continue;
    }
    if (v.verdict === "here") {
      // Back from out or low, or else a look that refreshes when it was last seen.
      writes.push(stillHere(it, { why, src }) ?? { op: "set", item: it.id, why, src });
      out.said.push(`${it.name}: still here`);
    } else if (v.verdict === "low") {
      writes.push({ op: "set", item: it.id, fields: { level: "low" }, why, src });
      out.said.push(`${it.name}: marked low`);
    } else {
      writes.push({ op: "use", item: it.id, qty: null, why, src });
      out.said.push(`${it.name}: marked out`);
    }
  }

  if (writes.length) out.batch = append(account, writes);
  if (suspicions.length) suspect(account, suspicions, now);
  // A told verdict answers any suspicion outright; a reasoned "here" or
  // "frozen" withdraws one the kitchen held.
  const withdrawn = opts.told
    ? settled
    : settled.filter((id) => !suspicions.some((s) => s.id === id));
  if (withdrawn.length) clearSuspects(account, withdrawn);
  markReviewed(account, settled, now);
  return out;
}
