/**
 * How well a dish fits TONIGHT, as opposed to what kind of day it is.
 *
 * `mood.ts` reads the calendar and the weather and answers "what kind of day is
 * this". That is real information, and on its own it is also why the grid went
 * bland. A score built only from the day cannot know that the ground beef went
 * out of date yesterday, that this exact dinner was eaten on Tuesday, or that
 * the one time anybody made it they gave it a two.
 *
 * Underneath the mood the sort fell through to `fewest missing ingredients,
 * then fastest`, which is an explicit preference for the blandest pantry-stable
 * thing in the catalog. That is not a tuning problem. A ranking with no term
 * for quality finds the least interesting dinner every single time, and it is
 * right by its own lights while doing it.
 *
 * Three facts the ledger already holds and nothing was reading:
 *
 *   URGENCY  what the dish spends that would otherwise be thrown out
 *   NOVELTY  how long since this house last ate it
 *   REGARD   whether anybody starred it, or said how it turned out
 *
 * These RANK and never FILTER, the same contract the mood keeps. A dish that
 * uses nothing urgent still appears; it just stops winning by default.
 */

import { type MadeIndex, lastMade } from "./made.ts";
import { type ProfileState, notesFor } from "./profile.ts";
import type { Recipe } from "./recipes.ts";
import { daysLeft } from "./store.ts";
import type { Item } from "./types.ts";

/**
 * Points for one ingredient's clock.
 *
 * Peaks the day before and the day of, not on the oldest thing in the fridge.
 * Something four days past date is a bin decision, not a dinner decision, and a
 * curve that kept climbing would have the home page leading with whatever has
 * been sitting there longest. It still scores above zero, because a day-old
 * package of beef is usually fine and this is a ranking, not a verdict.
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
 * Deliberately dominated by the SINGLE most urgent ingredient rather than the
 * sum. One protein a day past its date is the entire reason to cook a
 * particular dinner; eight things at four days out is not, and summing lets a
 * long ingredient list beat the dish that actually saves the beef. The rest
 * contribute at a quarter weight, which is enough to break a tie between two
 * dishes that both use it.
 *
 * An ingredient the ledger has never heard of scores ZERO rather than a
 * penalty. Not tracked is not the same claim as not here, and a lookup miss
 * must never read as an opinion about the dish.
 */
export function urgency(r: Recipe, items: Record<string, Item>, now = new Date()): number {
  const points: number[] = [];
  for (const [id] of r.needs) {
    const it = items[id];
    if (!it || it.gone) continue;
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
 * Points for not having eaten this lately.
 *
 * The penalty near zero days is the biggest single number in this file on
 * purpose. Nothing else in the ranking could stop the same three cards leading
 * the page every evening, and a correct suggestion you have already eaten twice
 * this week is the exact failure that makes somebody stop opening the site.
 *
 * Never made is a mild BOOST, not a penalty: an untried dish in a catalog this
 * small is more likely to be a good night than the fourth repeat of one.
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
 * Points for what people said about it.
 *
 * A star is a standing preference and counts once no matter how many people
 * added one, because two housemates starring a dish does not make it twice as
 * good for the person reading the page. Ratings are averaged and centred on
 * three, so an unrated dish scores zero rather than being punished for having
 * no history, and a dish somebody rated a two sinks by as much as a five lifts.
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

/**
 * The reason a dish is where it is, in words, or null when there is nothing
 * worth saying.
 *
 * A ranking nobody can see is a ranking nobody trusts, and the first thing
 * anyone asks about a reordered list is why. This is also the honest test of
 * whether a term earned its place: if the score moved a card to the top and
 * there is no sentence for it, the term is doing something the household would
 * not agree with.
 */
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
    if (!it || it.gone) continue;
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
 * What is actually running out, worst first.
 *
 * Shared by the ranking and by the page that offers to write a dish around it,
 * so the sentence a person reads and the score that ordered the grid cannot
 * disagree about which food is urgent.
 */
export function onTheClock(
  items: Record<string, Item>,
  withinDays = 1,
  now = new Date(),
): Array<{ item: Item; days: number }> {
  const out: Array<{ item: Item; days: number }> = [];
  for (const it of Object.values(items)) {
    if (it.gone) continue;
    const d = daysLeft(it, now);
    // More than two days past date is a bin decision, not a dinner decision,
    // and offering to cook it would be the one suggestion here nobody should
    // follow. Same cutoff `clockPoints` uses, for the same reason.
    if (d === null || d > withinDays || d < -2) continue;
    out.push({ item: it, days: d });
  }
  return out.sort((a, b) => a.days - b.days);
}
