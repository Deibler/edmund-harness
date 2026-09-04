/**
 * Event-sourced inventory, one append-only log per account.
 *
 * The current state of a kitchen is a fold over its log, recomputed on every
 * read. That means the log is the only thing that has to be right, any batch
 * can be retracted, and every derived feature in this integration — spend,
 * calories, meal timing, the recap — is a different fold over the same events
 * rather than a second store that can drift.
 *
 * Isolation is the file boundary. Nothing in this module takes two accounts,
 * so there is no query that can span them and nothing to remember to scope.
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

/** Lines that would not parse, by account. Surfaced rather than thrown. */
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
      // A single unparseable line used to throw out of here, which meant every
      // tool in this integration failed for that household — inventory, plans,
      // the site, all of it — until a human hand-edited the file. Two writers
      // append to this log with no lock, and a process killed mid-append leaves
      // exactly one truncated line. Losing one event is bad; losing the whole
      // kitchen because of it is much worse. Skip it and let the caller report.
      bad.push(i + 1);
    }
  }
  if (bad.length) corruptLines.set(account, bad);
  else corruptLines.delete(account);
  return out;
}

/**
 * Write a group of events sharing one batch id. Returns the batch id.
 *
 * One batch per user-visible action is what makes `undo` a single honest
 * operation: a six-ingredient dinner logged wrong is one retraction, not six.
 */
export function append(account: string, events: Partial<KitchenEvent>[]): string {
  const batch = shortId();
  if (!events.length) {
    // Nothing to write. Falling through appended a bare newline, because the
    // join of an empty list is an empty string and the terminator went on
    // anyway. Harmless to the fold, which skips blank lines, but it put
    // untraceable whitespace in an append-only file that is meant to be
    // readable by a human with `less`.
    return batch;
  }
  const ts = nowIso();
  const path = logPath(account);
  mkdirSync(dirname(path), { recursive: true });
  const body = events.map((e) => JSON.stringify({ ...e, ts: e.ts ?? ts, batch })).join("\n");
  appendFileSync(path, `${body}\n`);
  return batch;
}

/**
 * Batch ids an undo has retracted.
 *
 * Key on `batch_target`, never the undo event's own `batch` — `append` stamps
 * every event with a fresh id, so reading `batch` here retracts the undo
 * itself and nothing else. That was a live bug in the Python engine until
 * 2026-08-16; keeping the helper named and shared stops it coming back.
 */
export function droppedBatches(events: KitchenEvent[]): Set<string> {
  // An undo only counts if it has not itself been retracted — that is what makes
  // undoing an undo restore the original batch. Walking BACKWARDS decides that
  // in one pass: any undo that cancels this one is necessarily later, so it has
  // already been resolved by the time we get here. A naive forward union let a
  // retracted undo keep suppressing its target.
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
      // `undefined` means the writer said nothing about this field. `null` means
      // it said "there is no value" — clearing a wrong expiry date is a real
      // correction, and skipping nulls made it impossible: once a date was on an
      // item nothing could take it off again. Level is the exception, because a
      // null level is how "no level was mentioned" reaches here from a qty-only
      // add, and honouring that would wipe the level of every counted staple.
      if (v === undefined) continue;
      if (v === null && k === "level") continue;
      (it as Record<string, unknown>)[k] = v;
    }
    it.updated = e.ts;
    const q = e.qty ?? null;

    if (e.op === "add") {
      // An `add` asserts the thing is in the house now, so whatever the last
      // emptying left behind is stale from this event forward. Without this a
      // restock INHERITS the emptiness: `it.level ?? "full"` reads the "out"
      // that finishing the item just wrote, and an add carrying no count leaves
      // the qty 0 that the use-all set. Buy olive oil, log it, and the page says
      // "0" and "out" for something that came through the door a minute ago.
      // This is the other half of use-to-zero setting level="out" — that rule is
      // right, but it made a stale "out" reachable by a path that never had one.
      //
      // "low" is stale for the same reason and used to survive, because only
      // "out" was cleared. Buying more of something is exactly the act that
      // stops it being low, so a shelf check saying "running low on milk"
      // outlived the jug bought two days later and kept milk on the shopping
      // list indefinitely. An add that names its own level still wins: that is
      // somebody saying how much actually came home.
      if (q !== null) it.qty = round((it.qty ?? 0) + q);
      else if (it.gone) it.qty = null; // restocked, and nobody counted it
      const carried = it.level === "out" || it.level === "low" ? null : it.level;
      it.level = (e.fields?.level ?? carried ?? "full") as Level;
      // The date goes stale for exactly the reason the level does. An item that
      // was empty still carries the clock of the pack somebody finished, so a
      // restock inherited an expiry already in the past: pork bought this
      // morning read as thirteen days expired and fell straight out of meal
      // planning. An add that names its own date still wins. A top-up of
      // something still in the house keeps the older clock, which is the
      // conservative read while both packs are on the shelf.
      if (it.gone && !(e.fields && "expires" in e.fields)) it.expires = null;
      it.gone = false;
      it.used_since_check = 0;
      it.uses_since_check = 0;
    } else if (e.op === "use") {
      // `some` is the difference between "we finished the ranch" and "a wrap
      // used some ranch". Both arrive here with no quantity, and only the first
      // one means the bottle is empty — see the field's note in types.ts.
      if (q === null && !e.some) {
        it.qty = 0;
        it.level = "out";
        it.gone = true;
      } else if (it.qty === null) {
        // Level-tracked staple: nobody knows how many teaspoons are in the jar,
        // so a measured use accrues against the item instead of moving the
        // level. Stepping the level on every pinch put salt, pepper and olive
        // oil on the shopping list after a single dinner. The running total is
        // a reason for a human to look, not a claim about what is left.
        it.used_since_check = round((it.used_since_check ?? 0) + (q ?? 0));
        it.use_unit = e.unit ?? it.use_unit;
        it.uses_since_check = (it.uses_since_check ?? 0) + 1;
      } else if (q === null) {
        // Marked `some` but the item turned out to be counted after all — the
        // shelf changed between the write and the fold. Recording the touch
        // without inventing a number is the honest floor; guessing one, or
        // falling through to the subtraction with a null, is not.
        it.uses_since_check = (it.uses_since_check ?? 0) + 1;
      } else {
        it.qty = round(Math.max(0, it.qty - q));
        it.gone = it.qty === 0;
        // Keep level and qty telling the same story. Using the last of something
        // left `level` at "full" beside a qty of 0, and any later write that
        // consulted the level read a full container. The use-all branch above
        // already does this; a counted item reaching zero is the same event.
        if (it.gone) it.level = "out";
      }
    } else if (e.op === "set") {
      // A null qty is "nobody counted this", not "there are zero". Treating it as
      // a quantity assertion let a metadata correction that happened to carry a
      // null qty decide whether the item still exists.
      const setsQty = typeof e.qty === "number";
      const setsLevel = !!e.fields && "level" in e.fields && e.fields.level != null;
      if (setsQty) it.qty = q;
      if (setsLevel) {
        // Somebody physically looked in the container, which is the only thing
        // that ever knew. Everything accrued since the last look is now spent.
        it.level = e.fields!.level as Level;
        it.used_since_check = 0;
        it.uses_since_check = 0;
      }
      // A set that names a real quantity is a fresh count, so it also clears a
      // stale "out" left behind by an earlier use-it-all; otherwise `set --qty 5`
      // would leave the item marked gone with five of them on the shelf.
      if (setsQty && (q ?? 0) > 0 && !setsLevel && it.level === "out") it.level = null;
      // Only a set that actually carries a quantity or a level may decide whether
      // the item is still in the house. A metadata correction — fixing a display
      // name, adding an alias, clearing a bad date — used to run `gone = (q === 0)`
      // with q defaulted to null, which resurrected anything already consumed.
      // Renaming an empty milk jug put milk back in the fridge, which is exactly
      // the false "yes we have it" this ledger exists to stop.
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
 * Split candidates into ones the query really names and ones it merely touches.
 *
 * This distinction is the whole safety property of the ledger. "eggs" appears
 * inside "wide egg noodles", and a lookup that answers yes to that is worse
 * than one that answers nothing at all. Anything that MUTATES must use `exact`;
 * a loose hit is reported as a loose hit and never silently stands in.
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

// `now` is injectable because every clock decision downstream of this — what
// leads the page, what the card says, what gets offered as dinner — is a
// function of it, and a caller that cannot name the day can only be tested
// against the day the test happens to run on.
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

export { newPlanId };
function newPlanId(): string {
  return shortId(6);
}
