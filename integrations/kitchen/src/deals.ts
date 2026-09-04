/**
 * Store pricing and best-deal ranking across Aldi, Giant, Walmart and Target.
 *
 * **Division of labour, and why.** This module owns storage, normalisation,
 * matching and ranking — all deterministic, all testable. It does NOT fetch.
 * Acquisition needs a browser, a store, a ZIP code and judgment about whether
 * the page actually loaded, which is the model's job through the existing web
 * tooling, handed back via `kitchen_price_import`.
 *
 * That split is deliberate. The alternative — a scraper buried in here that
 * silently returns nothing when a retailer changes their markup — produces a
 * deals page that looks fine and is quietly empty or, worse, stale. Prices
 * carry `fetched` and every read reports its age, because a grocery price from
 * three weeks ago presented as today's is a lie with a decimal point on it.
 *
 * An empty cache is an honest state and says so. It is never backfilled with
 * plausible-looking numbers.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { baseDir } from "./accounts.ts";
import { priceMaxAgeDays } from "./settings.ts";
import { slug } from "./store.ts";

export const STORES = ["aldi", "giant", "walmart", "target"] as const;
export type Store = (typeof STORES)[number];

/** Resolved per call, like every other path in this integration. */
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
  /** Normalised unit price where the size was parseable — the only fair compare. */
  unitPrice?: number | null;
  unit?: string | null;
  /** True when it is a sale/circular price rather than shelf price. */
  sale?: boolean;
  /** When the sale ends, if known. A deal nobody can still get is noise. */
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
 * Parse a pack size into a comparable unit price.
 *
 * "$3.99 for 16 oz" versus "$5.49 for 32 oz" is the entire point of a deals
 * feature — comparing sticker prices across different pack sizes is worse than
 * useless, it recommends the wrong thing. Sizes it cannot parse return null and
 * are ranked separately rather than being guessed into comparability.
 */
export function unitize(
  price: number,
  size?: string | null,
): { unitPrice: number | null; unit: string | null } {
  if (!size) return { unitPrice: null, unit: null };
  const s = size.toLowerCase().trim();
  // A leading count is optional: shelf tags say "dozen" and "each" as often as
  // "12 ct", and treating those as unparseable dropped eggs — one of the most
  // price-compared items in a grocery store — out of every ranking.
  const m = /^([\d.]+)?\s*(fl\.?\s*oz|floz|oz|lbs|lb|kg|g|ml|l|ct|count|each|dozen|pk|pack)\b/.exec(
    s,
  );
  // A number with no unit token used to fall through to "ct". That silently
  // turned "16 fl oz" into sixteen COUNT, which then ranked against a real
  // per-ounce row as if the two were comparable. An unparseable size has to stay
  // unparseable — it gets ranked on sticker price instead, which is honest.
  if (!m || !m[2]) return { unitPrice: null, unit: null };
  let n = m[1] ? Number.parseFloat(m[1]) : 1;
  let unit = m[2].replace(/\./g, "").replace(/\s+/g, "");
  if (!Number.isFinite(n) || n <= 0) return { unitPrice: null, unit: null };
  if (unit === "floz") {
    /* already normalised */
  }
  // Normalise to a small set so cross-store compare is apples to apples.
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
    // One current price per (item, store): a price book with three ages of the
    // same row silently ranks on whichever the sort happened to reach first.
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
 * Best price per item for a shopping list.
 *
 * Ranking: a live sale beats shelf price, then unit price where both sides
 * parsed, then sticker price. `preferred` breaks genuine ties only — it never
 * overrides a real saving, because a store preference is a convenience and
 * money is money.
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
    // Unit price is only a fair comparison when every candidate is measured in the
    // SAME unit. Ranking $/oz against $/ct because both happened to be non-null
    // recommends whichever unit divides into a smaller number, which is arithmetic
    // pretending to be a saving. Mixed units fall back to sticker price for all of
    // them, so at least everyone is compared on the same thing.
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
      // Never report a negative saving. When ranking went by unit price the best
      // row can carry the higher sticker (a bigger pack), and `worst - best` then
      // printed "saves $-3.00", which reads as a bug to anyone looking at it.
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
 * Which store to actually drive to, given a whole list.
 *
 * People do one trip, not four. Optimising each line independently produces a
 * "best deal" that requires visiting every retailer in Lancaster County, so
 * this scores each store on the basket it can actually cover.
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
