/**
 * Store prices and best-deal ranking across Aldi, Giant, Walmart and Target.
 *
 * This module stores, normalises, matches and ranks; it never fetches. Getting a
 * price needs a browser and judgement about whether the page loaded, which the
 * model does and hands back through `kitchen_prices_import`. Every row carries
 * `fetched` and reads report its age, so a stale price is never quoted as
 * today's. An empty cache stays empty rather than being filled with guesses.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { baseDir } from "./accounts.ts";
import { priceMaxAgeDays } from "./settings.ts";
import { slug } from "./store.ts";

export const STORES = ["aldi", "giant", "walmart", "target"] as const;
export type Store = (typeof STORES)[number];

/** Resolved per call, so a configured data directory always applies. */
export function priceFile(): string {
  return join(baseDir(), "prices.json");
}

export type PriceRow = {
  /** Ledger slug this price is for, so matching needs no fuzzy join at read time. */
  item: string;
  store: Store;
  /** What the shelf says, in dollars, for `size`. */
  price: number;
  /** Human size the price covers, e.g. "16 oz", "dozen", "each". */
  size?: string | null;
  /** Normalised unit price, when the size was parseable. */
  unitPrice?: number | null;
  unit?: string | null;
  /** True when it is a sale/circular price rather than shelf price. */
  sale?: boolean;
  /** When the sale ends, if known. */
  saleEnds?: string | null;
  fetched: string;
  /** Where it came from, e.g. a URL or "weekly circular". Auditable. */
  source?: string | null;
};

export type PriceBook = { version: number; rows: PriceRow[] };

export function loadPrices(): PriceBook {
  if (!existsSync(priceFile())) return { version: 1, rows: [] };
  return JSON.parse(readFileSync(priceFile(), "utf8")) as PriceBook;
}

export function savePrices(book: PriceBook): void {
  const f = priceFile();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(book, null, 2)}\n`);
  renameSync(tmp, f);
}

/**
 * Parse a pack size into a unit price comparable across stores (oz, fl oz or
 * count). An unparseable size returns null and is ranked on sticker price
 * instead of being guessed into comparability.
 */
export function unitize(
  price: number,
  size?: string | null,
): { unitPrice: number | null; unit: string | null } {
  if (!size) return { unitPrice: null, unit: null };
  const s = size.toLowerCase().trim();
  // A leading count is optional ("dozen", "each").
  const m = /^([\d.]+)?\s*(fl\.?\s*oz|floz|oz|lbs|lb|kg|g|ml|l|ct|count|each|dozen|pk|pack)\b/.exec(
    s,
  );
  // A number with no recognised unit stays unparseable; defaulting to "ct"
  // would compare counts against ounces.
  if (!m || !m[2]) return { unitPrice: null, unit: null };
  let n = m[1] ? Number.parseFloat(m[1]) : 1;
  let unit = m[2].replace(/\./g, "").replace(/\s+/g, "");
  if (!Number.isFinite(n) || n <= 0) return { unitPrice: null, unit: null };
  if (unit === "lb" || unit === "lbs") {
    n *= 16;
    unit = "oz";
  } else if (unit === "kg") {
    n *= 35.274;
    unit = "oz";
  } else if (unit === "g") {
    n /= 28.35;
    unit = "oz";
  } else if (unit === "l") {
    n *= 33.814;
    unit = "floz";
  } else if (unit === "ml") {
    n /= 29.574;
    unit = "floz";
  } else if (unit === "dozen") {
    n *= 12;
    unit = "ct";
  } else if (unit === "count" || unit === "pk" || unit === "pack" || unit === "each") unit = "ct";
  return { unitPrice: Math.round((price / n) * 10000) / 10000, unit };
}

export function importPrices(rows: Array<Omit<PriceRow, "fetched"> & { fetched?: string }>): {
  added: number;
  replaced: number;
  stores: string[];
} {
  const book = loadPrices();
  const now = new Date().toISOString();
  let added = 0;
  let replaced = 0;
  for (const r of rows) {
    const item = slug(r.item);
    const { unitPrice, unit } = unitize(r.price, r.size);
    const row: PriceRow = {
      ...r,
      item,
      fetched: r.fetched ?? now,
      unitPrice: r.unitPrice ?? unitPrice,
      unit: r.unit ?? unit,
    };
    // One current price per (item, store).
    const i = book.rows.findIndex((x) => x.item === item && x.store === r.store);
    if (i >= 0) {
      book.rows[i] = row;
      replaced += 1;
    } else {
      book.rows.push(row);
      added += 1;
    }
  }
  savePrices(book);
  return { added, replaced, stores: [...new Set(rows.map((r) => r.store))] };
}

export type Deal = {
  item: string;
  name: string;
  best: PriceRow | null;
  alternatives: PriceRow[];
  /** Dollars saved versus the most expensive store carrying it. */
  saves: number | null;
  ageDays: number | null;
  note?: string;
};

const DAY = 86400000;

function ageDays(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / DAY);
}

/**
 * Best price per item for a shopping list. A live sale beats shelf price, then
 * unit price when every row shares a unit, then sticker price; `preferred`
 * stores only break exact ties.
 */
export function bestDeals(
  wanted: Array<{ id: string; name: string }>,
  opts: { preferred?: string[]; maxAgeDays?: number } = {},
): { deals: Deal[]; staleness: { rows: number; oldestDays: number | null; stores: string[] } } {
  const book = loadPrices();
  const maxAge = opts.maxAgeDays ?? priceMaxAgeDays();
  const pref = opts.preferred ?? [];
  const deals: Deal[] = [];

  for (const w of wanted) {
    const rows = book.rows.filter((r) => r.item === w.id && ageDays(r.fetched) <= maxAge);
    if (!rows.length) {
      deals.push({
        item: w.id,
        name: w.name,
        best: null,
        alternatives: [],
        saves: null,
        ageDays: null,
        note: book.rows.some((r) => r.item === w.id)
          ? "only stale prices on file for this — refresh before quoting"
          : "no price on file yet",
      });
      continue;
    }
    // Unit prices only compare within one unit; mixed units fall back to sticker.
    const units = new Set(rows.filter((r) => r.unitPrice != null).map((r) => r.unit ?? "?"));
    const comparableUnits = units.size <= 1 && rows.every((r) => r.unitPrice != null);
    const score = (r: PriceRow) => {
      const live = r.sale && (!r.saleEnds || new Date(r.saleEnds) >= new Date());
      return [
        live ? 0 : 1,
        comparableUnits ? (r.unitPrice ?? Number.POSITIVE_INFINITY) : 0,
        r.price,
        pref.indexOf(r.store) === -1 ? 99 : pref.indexOf(r.store),
      ];
    };
    const sorted = [...rows].sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      for (let i = 0; i < sa.length; i++)
        if (sa[i] !== sb[i]) return (sa[i] as number) - (sb[i] as number);
      return 0;
    });
    const best = sorted[0]!;
    const worst = [...rows].sort((a, b) => b.price - a.price)[0]!;
    deals.push({
      item: w.id,
      name: w.name,
      best,
      alternatives: sorted.slice(1),
      // Never a negative saving: ranked by unit price, the best row can be a
      // bigger pack with a higher sticker.
      saves:
        rows.length > 1 && worst.price > best.price
          ? Math.round((worst.price - best.price) * 100) / 100
          : null,
      ageDays: ageDays(best.fetched),
    });
  }

  const ages = book.rows.map((r) => ageDays(r.fetched));
  return {
    deals,
    staleness: {
      rows: book.rows.length,
      oldestDays: ages.length ? Math.max(...ages) : null,
      stores: [...new Set(book.rows.map((r) => r.store))],
    },
  };
}

/**
 * Which single store to shop, given a whole list: stores ranked by how much of
 * the basket they cover, then by total. People make one trip, not four.
 */
export function bestBasket(
  wanted: Array<{ id: string; name: string }>,
  maxAgeDays = priceMaxAgeDays(),
) {
  const book = loadPrices();
  const out: Array<{ store: string; covers: number; total: number; missing: string[] }> = [];
  for (const store of STORES) {
    let total = 0;
    const missing: string[] = [];
    let covers = 0;
    for (const w of wanted) {
      const r = book.rows.find(
        (x) => x.item === w.id && x.store === store && ageDays(x.fetched) <= maxAgeDays,
      );
      if (r) {
        total += r.price;
        covers += 1;
      } else missing.push(w.name);
    }
    if (covers) out.push({ store, covers, total: Math.round(total * 100) / 100, missing });
  }
  // Coverage first: a cheap basket missing half the list is not a shopping trip.
  return out.sort((a, b) => b.covers - a.covers || a.total - b.total);
}
