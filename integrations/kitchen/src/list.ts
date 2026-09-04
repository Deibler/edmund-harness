/**
 * The grocery list you can actually add something TO.
 *
 * Until now the list was purely derived: anything the ledger believed had run
 * out, plus whatever stood between the kitchen and a nearly-cookable dish. That
 * is a good list and it is not a complete one, because it can only ever contain
 * things the house used to have. "I want to make the chicken parm on Thursday
 * and we have never owned breadcrumbs" is invisible to a derived list, and it
 * is the single most common reason a person opens a shopping list at all.
 *
 * So there is a written layer on top. It is kept OUT of the event log on
 * purpose. The log is a record of what happened to food; wanting to buy
 * something is not something that happened, and folding intent into the same
 * stream would mean an unbought item either lingers in inventory as a lie or
 * needs a second retraction event to cancel a plan that was never real.
 *
 * The list is also allowed to be wrong for a while. Nothing here consumes or
 * produces stock. Buying is still recorded by a receipt, which is the only
 * thing that knows what was actually paid.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountDir } from "./accounts.ts";
import { nowIso, slug } from "./store.ts";

export type ListEntry = {
  /** Stable handle for ticking and removal. Slug of the name. */
  key: string;
  /** What to look for on the shelf, in a shopper's words. */
  name: string;
  /** How much to buy, as prose: "1 lb", "a bunch", "2 cans". Optional. */
  amount?: string | null;
  /** Ledger slug when this maps to something the kitchen already tracks. */
  item?: string | null;
  /** Which dish put it here, so a line is defensible three days later. */
  why?: string | null;
  /** Aisle-ish grouping, reusing ledger categories so the list sorts sanely. */
  cat?: string | null;
  added: string;
  by?: string | null;
};

export type List = { version: 1; entries: ListEntry[] };

export function listPath(account: string): string {
  return join(accountDir(), account, "list.json");
}

export function readList(account: string): List {
  const p = listPath(account);
  if (!existsSync(p)) return { version: 1, entries: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<List>;
    return { version: 1, entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch {
    // A corrupt list costs the written lines, not the derived ones. Same call as
    // everywhere else in this integration: degrade to less, never to nothing.
    return { version: 1, entries: [] };
  }
}

function writeList(account: string, l: List): void {
  const p = listPath(account);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(l, null, 2));
}

/**
 * Add lines, merging rather than duplicating.
 *
 * Two dishes both wanting heavy cream is one carton and two reasons, not two
 * lines. Merging on the key and appending the reason is what keeps the list
 * short enough to shop from, which is the only quality it has to have.
 *
 * Returns the entries that were genuinely new, so a caller can say what it did
 * without re-reading the file.
 */
export function addToList(
  account: string,
  entries: Array<Omit<ListEntry, "key" | "added"> & { key?: string; added?: string }>,
): { added: ListEntry[]; merged: string[] } {
  const l = readList(account);
  const byKey = new Map(l.entries.map((e) => [e.key, e]));
  const added: ListEntry[] = [];
  const merged: string[] = [];

  for (const raw of entries) {
    const key = raw.key ?? slug(raw.item ?? raw.name);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      const why = [existing.why, raw.why].filter(Boolean).join("; ");
      // Only widen. A second dish asking for the same thing should never shrink
      // an amount somebody already wrote down.
      existing.why = why || null;
      if (!existing.amount && raw.amount) existing.amount = raw.amount;
      merged.push(existing.name);
      continue;
    }
    const e: ListEntry = {
      key,
      name: raw.name,
      amount: raw.amount ?? null,
      item: raw.item ?? null,
      why: raw.why ?? null,
      cat: raw.cat ?? null,
      added: raw.added ?? nowIso(),
      by: raw.by ?? null,
    };
    byKey.set(key, e);
    l.entries.push(e);
    added.push(e);
  }

  writeList(account, l);
  return { added, merged };
}

/**
 * Change how much of something to buy.
 *
 * Its own function rather than a flag on `addToList`, because that one only
 * ever widens: a second dish asking for cream must not shrink an amount
 * somebody wrote down. This is the opposite intent — a person correcting the
 * line — and it has to be able to overwrite. Returns false when the line is not
 * written down, which is the caller's cue to write it first.
 */
export function setAmount(account: string, key: string, amount: string | null): boolean {
  const l = readList(account);
  const e = l.entries.find((x) => x.key === key || x.item === key);
  if (!e) return false;
  e.amount = amount?.trim() ? amount.trim() : null;
  writeList(account, l);
  return true;
}

export function removeFromList(account: string, keys: string[]): number {
  const l = readList(account);
  const drop = new Set(keys);
  const before = l.entries.length;
  l.entries = l.entries.filter((e) => !drop.has(e.key) && !drop.has(e.item ?? ""));
  writeList(account, l);
  return before - l.entries.length;
}

export function clearList(account: string): void {
  writeList(account, { version: 1, entries: [] });
}
