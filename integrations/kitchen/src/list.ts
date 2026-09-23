/**
 * The written shopping list: lines somebody (or the model) added on purpose.
 *
 * The derived list can only contain things the house used to have; this layer
 * holds everything else ("breadcrumbs for Thursday's chicken parm"). It lives
 * outside the event log because wanting to buy something is not something that
 * happened to food. Nothing here changes stock; a receipt does that.
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
    // A corrupt file loses the written lines only; the derived list still works.
    return { version: 1, entries: [] };
  }
}

function writeList(account: string, l: List): void {
  const p = listPath(account);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(l, null, 2));
}

/**
 * Add lines, merging on the key: two dishes wanting cream is one line with two
 * reasons. Returns the new entries and the names that were merged.
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
      // Only widen: never overwrite an amount already written down.
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
 * Overwrite how much of a written line to buy: a person's correction, unlike
 * `addToList`, which never changes an existing amount. False when no such line.
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
