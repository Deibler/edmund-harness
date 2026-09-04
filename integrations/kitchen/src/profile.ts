/**
 * Who is using the site right now, and the things they mark while using it.
 *
 * The household is the unit of ISOLATION — one fridge, one ledger. The person
 * is the unit of PREFERENCE: a favourite is Alex's, not the kitchen's, and a
 * note on a dinner belongs to whoever cooked it. So this sits alongside the
 * ledger rather than inside it. None of it is an event: a favourite has no
 * time, it has a current value, and folding it out of an append-only log would
 * mean replaying history to answer "is this starred".
 *
 * The browser picks a profile once and keeps it in a cookie, which is what
 * makes "text this to me" mean something on a page two people share.
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
 * A leg of a compound pair somebody has said they are not doing.
 *
 * Keyed "parentId>childId" so declining "roast pork then banh mi" does not
 * silently decline every other pork pairing. Dated, because a decision about
 * this week's dinner should not still be suppressing a suggestion in October.
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
    // Every field is listed here, and every field added later must be added
    // here too. Rebuilding the object from a fixed set rather than spreading it
    // means a new field is silently discarded on the next read: pair skips were
    // written correctly and forgotten a second later, which looks exactly like
    // a button that does nothing.
    return { favorites: raw.favorites ?? {}, notes: raw.notes ?? {}, skips: raw.skips ?? [] };
  } catch {
    // Preferences are not the ledger. Losing a star is survivable; refusing to
    // render the site because one of them is malformed is not.
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

/**
 * Pairs somebody has opted out of, still inside their shelf life.
 *
 * Fourteen days, matching the decay engine's vindication window: a human
 * decision outranks a suggestion, but not forever, because the kitchen the
 * decision was made about is gone by then.
 */
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
  // A decision can be reversed by making the thing, so this only ever grows to
  // the size of a season's worth of dinners. Trimmed anyway so the file cannot
  // become the biggest thing in the account directory.
  s.skips = s.skips.slice(-200);
  save(account, s);
}

export function unskipPair(account: string, pair: string): void {
  const s = loadProfiles(account);
  s.skips = (s.skips ?? []).filter((k) => k.pair !== pair);
  save(account, s);
}

export const favoritedBy = (s: ProfileState, recipe: string): string[] => s.favorites[recipe] ?? [];
export const notesFor = (s: ProfileState, key: string): MealNote[] => s.notes[key] ?? [];
