/**
 * How well a dish fits tonight, on top of what kind of day it is (`mood.ts`).
 *
 * Three terms from the ledger and the household's history:
 *
 *   urgency  what the dish uses that would otherwise be thrown out
 *   novelty  how long since the household last ate it
 *   regard   stars and ratings
 *
 * These rank and never filter. Without a quality term a ranking falls back to
 * "fewest missing, then fastest", which picks the blandest dish every time.
 */

import { isConvenience } from "./foods.ts";
import { type MadeIndex, lastMade } from "./made.ts";
import { type ProfileState, notesFor } from "./profile.ts";
import type { Recipe } from "./recipes.ts";
import { daysLeft } from "./store.ts";
import type { Item } from "./types.ts";

/**
 * Points for one ingredient's clock. Peaks the day before and the day of its
 * date; well past date is a bin decision rather than a dinner, so it scores low
 * but not zero.
 */
function clockPoints(days: number): number {
  if (days < -2) return 6;
  if (days <= 1) return 34;
  if (days <= 2) return 22;
  if (days <= 3) return 13;
  if (days <= 5) return 6;
  return 0;
}

/** Throwing out meat costs more than throwing out scallions. */
const COSTLY = new Set(["meat", "seafood", "dairy"]);

/**
 * Points for spending something that is about to be thrown away.
 *
 * Dominated by the single most urgent ingredient, with the rest at a quarter
 * weight, so a long ingredient list cannot outscore the dish that saves the
 * beef. An untracked ingredient scores zero: not tracked is not "not here".
 */
export function urgency(r: Recipe, items: Record<string, Item>, now = new Date()): number {
  const points: number[] = [];
  for (const [id] of r.needs) {
    const it = items[id];
    if (!it || it.gone) continue;
    // Lunch and snack food is eaten as it is; it never makes a dinner urgent.
    if (isConvenience(it)) continue;
    const d = daysLeft(it, now);
    if (d === null) continue;
    const p = clockPoints(d);
    if (p > 0) points.push(COSTLY.has(it.cat) ? p * 1.25 : p);
  }
  if (!points.length) return 0;
  points.sort((a, b) => b - a);
  const [top, ...rest] = points as [number, ...number[]];
  return Math.round(top + rest.reduce((n, p) => n + p, 0) * 0.25);
}

/**
 * Points for not having eaten this lately. The penalty for the last few days is
 * the largest number in the ranking, so the same dishes cannot lead every
 * evening. Never made is a mild boost.
 */
export function novelty(r: Recipe, made: MadeIndex, now = new Date()): number {
  const last = lastMade(made, r);
  if (!last) return 8;
  const then = new Date(`${last}T00:00:00`);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - then.getTime()) / 86400000);
  if (days < 0) return 0;
  if (days <= 2) return -40;
  if (days <= 6) return -18;
  if (days <= 13) return -6;
  if (days <= 29) return 0;
  return 10;
}

/**
 * Points for what people said about it. A star counts once however many people
 * added one; ratings are averaged and centred on three, so an unrated dish
 * scores zero.
 */
export function regard(r: Recipe, prof: ProfileState): number {
  let s = (prof.favorites[r.id]?.length ?? 0) > 0 ? 14 : 0;
  const rated = notesFor(prof, r.id)
    .map((n) => n.rating)
    .filter((n): n is number => typeof n === "number");
  if (rated.length) {
    const mean = rated.reduce((a, b) => a + b, 0) / rated.length;
    s += Math.round((mean - 3) * 8);
  }
  return s;
}

/** What the fridge and the history say, on top of what the day says. */
export function fitScore(
  r: Recipe,
  items: Record<string, Item>,
  made: MadeIndex,
  prof: ProfileState,
  now = new Date(),
): number {
  return urgency(r, items, now) + novelty(r, made, now) + regard(r, prof);
}

/** Why a dish ranks where it does, in words, or null when there is nothing worth saying. */
export function fitReason(
  r: Recipe,
  items: Record<string, Item>,
  made: MadeIndex,
  prof: ProfileState,
  now = new Date(),
): string | null {
  const soon: Array<{ name: string; days: number }> = [];
  for (const [id] of r.needs) {
    const it = items[id];
    if (!it || it.gone || isConvenience(it)) continue;
    const d = daysLeft(it, now);
    if (d !== null && d <= 2) soon.push({ name: it.name.toLowerCase(), days: d });
  }
  soon.sort((a, b) => a.days - b.days);
  const first = soon[0];
  if (first) {
    const when =
      first.days < 0 ? "is past date" : first.days === 0 ? "goes today" : "goes tomorrow";
    const more = soon.length > 1 ? ` and ${soon.length - 1} more on a clock` : "";
    return `Uses the ${first.name}, which ${when}${more}.`;
  }
  if (novelty(r, made, now) >= 10) return "Not made here in over a month.";
  if ((prof.favorites[r.id]?.length ?? 0) > 0) return "Starred.";
  return null;
}

/**
 * What is running out, worst first. Shared with the page that offers to write a
 * dish around it, so the page and the ranking agree on what is urgent.
 */
export function onTheClock(
  items: Record<string, Item>,
  withinDays = 1,
  now = new Date(),
): Array<{ item: Item; days: number }> {
  const out: Array<{ item: Item; days: number }> = [];
  for (const it of Object.values(items)) {
    if (it.gone || isConvenience(it)) continue;
    const d = daysLeft(it, now);
    // More than two days past date is a bin decision, not a dinner.
    if (d === null || d > withinDays || d < -2) continue;
    out.push({ item: it, days: d });
  }
  return out.sort((a, b) => a.days - b.days);
}
