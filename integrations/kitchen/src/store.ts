/**
 * Event-sourced inventory: one append-only JSONL log per household.
 *
 * Current state is a fold over the log, recomputed on every read, so the log is
 * the only thing that has to be right and any batch can be retracted. Spend,
 * calories and the recap are other folds over the same events.
 *
 * Isolation is the file boundary: nothing here takes two accounts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { logPath } from "./accounts.ts";
import {
  CATEGORIES,
  type Category,
  type Item,
  type KitchenEvent,
  LOCATIONS,
  type Level,
  type Location,
  type Plan,
} from "./types.ts";

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "item";
}

function shortId(n = 8): string {
  return Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(
    "",
  );
}

/** Line numbers that did not parse, by account. Reported by callers, never thrown. */
export const corruptLines = new Map<string, number[]>();

export function readLog(account: string): KitchenEvent[] {
  const path = logPath(account);
  if (!existsSync(path)) return [];
  const out: KitchenEvent[] = [];
  const bad: number[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as KitchenEvent);
    } catch {
      // Writers append without a lock, so a killed process can leave one torn
      // line. Skip it rather than take the whole household offline.
      bad.push(i + 1);
    }
  }
  if (bad.length) corruptLines.set(account, bad);
  else corruptLines.delete(account);
  return out;
}

/**
 * Append events under one shared batch id and return it. One batch per
 * user-visible action keeps `undo` a single retraction.
 */
export function append(account: string, events: Partial<KitchenEvent>[]): string {
  const batch = shortId();
  // An empty write would otherwise append a bare newline.
  if (!events.length) return batch;
  const ts = nowIso();
  const path = logPath(account);
  mkdirSync(dirname(path), { recursive: true });
  const body = events.map((e) => JSON.stringify({ ...e, ts: e.ts ?? ts, batch })).join("\n");
  appendFileSync(path, `${body}\n`);
  return batch;
}

/**
 * Batch ids retracted by an undo.
 *
 * Keyed on `batch_target`; the undo's own `batch` is a fresh id and names only
 * the undo. An undo counts only if it was not itself undone, which is what lets
 * undoing an undo restore the original. Walking backwards settles that in one
 * pass, because anything that cancels an undo comes later in the log.
 */
export function droppedBatches(events: KitchenEvent[]): Set<string> {
  const dropped = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.op !== "undo" || !e.batch_target) continue;
    if (dropped.has(e.batch)) continue;
    dropped.add(e.batch_target);
  }
  return dropped;
}

function blank(id: string, ts: string): Item {
  return {
    id,
    name: id.replace(/-/g, " "),
    cat: "other",
    loc: "pantry",
    qty: null,
    unit: "ct",
    level: null,
    expires: null,
    opened: false,
    aliases: [],
    added: ts,
    updated: ts,
    used_since_check: 0,
    uses_since_check: 0,
    use_unit: null,
    gone: false,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function fold(account: string, events?: KitchenEvent[]): Record<string, Item> {
  const evs = events ?? readLog(account);
  const dropped = droppedBatches(evs);
  const items: Record<string, Item> = {};

  for (const e of evs) {
    if (e.op === "undo" || dropped.has(e.batch)) continue;
    const id = e.item;
    if (!id) continue;
    let it = items[id];
    if (!it) {
      it = blank(id, e.ts);
      items[id] = it;
    }

    for (const [k, v] of Object.entries(e.fields ?? {})) {
      // `undefined` = field not mentioned; `null` = cleared (e.g. a wrong expiry
      // date). Level is the exception: a qty-only add carries `level: null` to
      // mean "not mentioned", and honouring it would wipe every counted level.
      if (v === undefined) continue;
      if (v === null && k === "level") continue;
      (it as Record<string, unknown>)[k] = v;
    }
    it.updated = e.ts;
    const q = e.qty ?? null;

    if (e.op === "add") {
      // An add asserts the item is in the house now, so emptiness left by the
      // last use is stale: a restock must not inherit qty 0, "out" or "low".
      // An add that names its own level still wins.
      if (q !== null) it.qty = round((it.qty ?? 0) + q);
      else if (it.gone) it.qty = null; // restocked, and nobody counted it
      const carried = it.level === "out" || it.level === "low" ? null : it.level;
      it.level = (e.fields?.level ?? carried ?? "full") as Level;
      // Likewise the finished pack's expiry, unless the add names a date. A
      // top-up of something still present keeps the older, more cautious date.
      if (it.gone && !(e.fields && "expires" in e.fields)) it.expires = null;
      it.gone = false;
      it.used_since_check = 0;
      it.uses_since_check = 0;
    } else if (e.op === "use") {
      // A null qty means "all of it" unless `some` is set ("a wrap used some
      // ranch" does not empty the bottle); see `KitchenEvent.some`.
      if (q === null && !e.some) {
        it.qty = 0;
        it.level = "out";
        it.gone = true;
      } else if (it.qty === null) {
        // Level-tracked staple: uses accrue for a human to check rather than
        // stepping the level, or one dinner would put salt on the list.
        it.used_since_check = round((it.used_since_check ?? 0) + (q ?? 0));
        it.use_unit = e.unit ?? it.use_unit;
        it.uses_since_check = (it.uses_since_check ?? 0) + 1;
      } else if (q === null) {
        // `some` against a counted item: record the touch, invent no number.
        it.uses_since_check = (it.uses_since_check ?? 0) + 1;
      } else {
        it.qty = round(Math.max(0, it.qty - q));
        it.gone = it.qty === 0;
        // Keep level consistent with a qty that reached zero.
        if (it.gone) it.level = "out";
      }
    } else if (e.op === "set") {
      // A null qty means "not counted", never "zero".
      const setsQty = typeof e.qty === "number";
      const setsLevel = !!e.fields && "level" in e.fields && e.fields.level != null;
      if (setsQty) it.qty = q;
      if (setsLevel) {
        // Somebody looked, so accrued uses are settled.
        it.level = e.fields!.level as Level;
        it.used_since_check = 0;
        it.uses_since_check = 0;
      }
      // A positive count is fresh evidence and clears a stale "out".
      if (setsQty && (q ?? 0) > 0 && !setsLevel && it.level === "out") it.level = null;
      // Only a count or a level decides presence. A metadata correction (a
      // rename, an alias, a cleared date) must not resurrect a finished item.
      if (setsQty || setsLevel) it.gone = it.qty === 0 || it.level === "out";
    } else if (e.op === "toss") {
      it.qty = 0;
      it.level = "out";
      it.gone = true;
    }
  }
  return items;
}

export function live(account: string, items?: Record<string, Item>): Item[] {
  const map = items ?? fold(account);
  return Object.values(map)
    .filter((i) => !i.gone)
    .sort(
      (a, b) =>
        a.cat.localeCompare(b.cat) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
}

/**
 * Split items into those the query names exactly (id, name or alias) and those
 * it merely appears in. "eggs" appears in "wide egg noodles", so anything that
 * writes must use `exact`; `near` is only ever reported as a near miss.
 */
export function match(query: string, items: Record<string, Item>) {
  const q = query.toLowerCase().trim();
  const qs = slug(q);
  const all = Object.values(items);
  const exact = all.filter(
    (i) =>
      i.id === qs || i.name.toLowerCase() === q || i.aliases.some((a) => a.toLowerCase() === q),
  );
  if (exact.length) return { exact, near: [] as Item[] };
  const hay = (i: Item) => [i.id, i.name, ...i.aliases].join(" ").toLowerCase();
  return { exact: [] as Item[], near: all.filter((i) => hay(i).includes(q)) };
}

/** Strict resolution for callers that will write. Throws rather than guessing. */
export function resolveOne(query: string, items: Record<string, Item>): Item {
  const m = match(query, items);
  if (m.exact.length === 1) return m.exact[0]!;
  if (m.exact.length > 1) {
    throw new Error(`"${query}" is ambiguous: ${m.exact.map((h) => h.id).join(", ")}`);
  }
  if (m.near.length) {
    throw new Error(
      `nothing is called "${query}". Closest: ${m.near
        .slice(0, 4)
        .map((h) => `"${h.name}"`)
        .join(", ")}. Use the full name, or add an alias to the right item.`,
    );
  }
  throw new Error(`no item matching "${query}". List the kitchen to see what is tracked.`);
}

export function openPlans(account: string, events?: KitchenEvent[]): Record<string, Plan> {
  const evs = events ?? readLog(account);
  const dropped = droppedBatches(evs);
  const open: Record<string, Plan> = {};
  for (const e of evs) {
    if (dropped.has(e.batch)) continue;
    if (e.op === "plan" && e.plan) open[e.plan.id] = e.plan;
    else if ((e.op === "plan_done" || e.op === "plan_void") && e.plan_id) delete open[e.plan_id];
  }
  return open;
}

/** Whole days until the item's printed date (negative once past), or null. */
export function daysLeft(item: Item, now = new Date()): number | null {
  if (!item.expires) return null;
  const d = new Date(`${item.expires}T00:00:00`);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

export function amount(item: Item): string {
  const { qty: q } = item;
  const u = item.unit || "ct";
  if (q === null) return (item.level ?? "in stock").replace("full", "in stock");
  const n = String(q);
  return u === "ct" ? n : `${n} ${u}`;
}

export const isCategory = (s: string): s is Category =>
  (CATEGORIES as readonly string[]).includes(s);
export const isLocation = (s: string): s is Location =>
  (LOCATIONS as readonly string[]).includes(s);

export function newPlanId(): string {
  return shortId(6);
}
