/**
 * Per-person marks made on the site: favourites, meal notes and declined pairs.
 *
 * The household is the unit of isolation (one fridge, one ledger); the person is
 * the unit of preference. These are current values rather than events, so they
 * live in `profile.json` beside the ledger instead of in it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";
import { nowIso } from "./store.ts";

export type MealNote = {
  /** Principal who wrote it. */
  who: string;
  text: string;
  at: string;
  /** 1-5, how it actually turned out. Null when they only left words. */
  rating?: number | null;
};

/**
 * A leg of a compound pair somebody declined. Keyed "parentId>childId" so one
 * decline does not suppress every pairing with the same parent; dated so it
 * expires (see `activeSkips`).
 */
export type PairSkip = { pair: string; leg: "parent" | "child"; at: string; by?: string | null };

export type ProfileState = {
  /** recipe id -> principals who starred it. */
  favorites: Record<string, string[]>;
  /** Declined halves of a compound pair, newest last. */
  skips?: PairSkip[];
  /** recipe id (or a cooked meal's key) -> notes, newest last. */
  notes: Record<string, MealNote[]>;
};

const empty = (): ProfileState => ({ favorites: {}, notes: {} });

function statePath(account: string): string {
  return join(accountDir(), account, "profile.json");
}

export function loadProfiles(account: string): ProfileState {
  const p = statePath(account);
  if (!existsSync(p)) return empty();
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ProfileState>;
    // Rebuilt from a fixed field list: a field added to ProfileState must be
    // added here too, or it is silently dropped on the next read.
    return { favorites: raw.favorites ?? {}, notes: raw.notes ?? {}, skips: raw.skips ?? [] };
  } catch {
    // A malformed preferences file must not stop the site rendering.
    return empty();
  }
}

function save(account: string, s: ProfileState): void {
  mkdirSync(join(accountDir(), account), { recursive: true });
  writeFileSync(statePath(account), JSON.stringify(s, null, 2));
}

/** Star or unstar for one person. Returns the new state of that star. */
export function toggleFavorite(account: string, recipe: string, who: string): boolean {
  const s = loadProfiles(account);
  const cur = new Set(s.favorites[recipe] ?? []);
  const on = !cur.has(who);
  if (on) cur.add(who);
  else cur.delete(who);
  if (cur.size) s.favorites[recipe] = [...cur];
  else delete s.favorites[recipe];
  save(account, s);
  return on;
}

export function addNote(
  account: string,
  key: string,
  note: Omit<MealNote, "at"> & { at?: string },
): MealNote {
  const s = loadProfiles(account);
  const full: MealNote = { ...note, at: note.at ?? nowIso(), rating: note.rating ?? null };
  s.notes[key] ??= [];
  s.notes[key].push(full);
  save(account, s);
  return full;
}

/** Declined pair legs from the last fourteen days, keyed `pair|leg`. */
export function activeSkips(s: ProfileState, now = Date.now()): Map<string, "parent" | "child"> {
  const out = new Map<string, "parent" | "child">();
  for (const k of s.skips ?? []) {
    if ((now - new Date(k.at).getTime()) / 86_400_000 < 14) out.set(`${k.pair}|${k.leg}`, k.leg);
  }
  return out;
}

export function skipPair(
  account: string,
  pair: string,
  leg: "parent" | "child",
  who: string | null,
): void {
  const s = loadProfiles(account);
  s.skips ??= [];
  s.skips.push({ pair, leg, at: nowIso(), by: who });
  s.skips = s.skips.slice(-200); // bounded; only the last fortnight is ever read
  save(account, s);
}

export function unskipPair(account: string, pair: string): void {
  const s = loadProfiles(account);
  s.skips = (s.skips ?? []).filter((k) => k.pair !== pair);
  save(account, s);
}

export const notesFor = (s: ProfileState, key: string): MealNote[] => s.notes[key] ?? [];
