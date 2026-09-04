/**
 * The day-reading engine, which is the one part of this integration that is
 * allowed to have an opinion.
 *
 * Two classes of bug are worth a test here and neither shows up on screen until
 * a particular week of the year arrives. The first is the calendar arithmetic:
 * Thanksgiving is a rule, not a date, and getting the fourth Thursday wrong
 * means the page is confidently festive on the wrong Thursday. The second is
 * ranking sanity: the scorer is a pile of additive nudges, and the failure mode
 * is not a crash, it is chocolate chip cookies at the top of dinner because a
 * tray of them keeps for four days. That one actually happened.
 */

import {
  VIBES,
  footballOn,
  moodFor,
  moodScore,
  occasionNow,
  occasionsIn,
  seasonOf,
} from "../src/mood.ts";
import { type Recipe, feedsAllWeek } from "../src/recipes.ts";
import type { Account } from "../src/types.ts";

import { check, section } from "./harness.ts";

const acct: Account = {
  name: "test",
  created: "2026-01-01T00:00:00+00:00",
  members: ["p"],
};

const dish = (over: Partial<Recipe>): Recipe => ({
  id: "x",
  name: "x",
  desc: "",
  minutes: 40,
  needs: [],
  cat: "dinner",
  ...over,
});

/* ── the calendar ────────────────────────────────────────────────────────── */

section("dates that are rules rather than dates");
const y26 = occasionsIn(2026);
const thx = y26.find((o) => o.id === "thanksgiving")!;
check("Thanksgiving 2026 is 26 November", thx.date.getMonth() === 10 && thx.date.getDate() === 26);
const labor = y26.find((o) => o.id === "labor")!;
check("Labor Day 2026 is 7 September", labor.date.getMonth() === 8 && labor.date.getDate() === 7);
const sb = y26.find((o) => o.id === "superbowl")!;
check(
  "Super Bowl 2026 is the second Sunday in February",
  sb.date.getMonth() === 1 && sb.date.getDay() === 0 && sb.date.getDate() === 8,
);
const easter26 = y26.find((o) => o.id === "easter")!;
check("Easter 2026 is 5 April", easter26.date.getMonth() === 3 && easter26.date.getDate() === 5);
const easter27 = occasionsIn(2027).find((o) => o.id === "easter")!;
check(
  "and Easter 2027 is 28 March",
  easter27.date.getMonth() === 2 && easter27.date.getDate() === 28,
);

section("an occasion only exists inside its own lead window");
check(
  "six days before Thanksgiving it is showing",
  occasionNow(new Date(2026, 10, 20))?.occ.id === "thanksgiving",
);
check("ten days before, it is not", occasionNow(new Date(2026, 10, 16))?.occ.id !== "thanksgiving");
check("the day after, it is gone", occasionNow(new Date(2026, 10, 27))?.occ.id !== "thanksgiving");
// Late December is the one place the year has to roll over, and a naive
// same-year search finds nothing there because Christmas has passed.
check(
  "29 December finds New Year's Eve, not nothing",
  occasionNow(new Date(2026, 11, 29))?.occ.id === "nye",
);

section("seasons and football");
check("August is summer", seasonOf(new Date(2026, 7, 16)) === "summer");
check("December is winter", seasonOf(new Date(2026, 11, 1)) === "winter");
check("October is football", footballOn(new Date(2026, 9, 12)));
check("May is not", !footballOn(new Date(2026, 4, 12)));

/* ── the mood ────────────────────────────────────────────────────────────── */

section("what the day argues for");
const tuesday = moodFor(acct, null, new Date(2026, 7, 18, 18));
check("an ordinary Tuesday keeps it easy", tuesday.vibe.id === "easy");
check("and says so without inventing an occasion", tuesday.occasion === null);
const sunday = moodFor(acct, null, new Date(2026, 7, 16, 12));
check("Sunday cooks for the week", sunday.vibe.id === "allweek");

const hot = moodFor(
  acct,
  {
    at: new Date().toISOString(),
    tempF: 94,
    highF: 96,
    lowF: 74,
    short: "Sunny",
    precip: 0,
    place: "Springfield",
  },
  new Date(2026, 7, 18, 18),
);
check("a 94 degree Tuesday goes light instead", hot.vibe.id === "light");
check("and the sentence mentions the heat", /94/.test(hot.line));
check("with no weather, the sentence never mentions any", !/degree|\d\d and /.test(tuesday.line));

const pinned = moodFor({ ...acct, prefs: { vibe: "ballout" } }, null, new Date(2026, 7, 18, 18));
check("a pinned vibe beats the day", pinned.vibe.id === "ballout" && pinned.pinned);
check("but the day's own answer is still carried", pinned.auto.id === "easy");
check(
  "a nonsense pinned vibe falls back rather than blanking",
  moodFor({ ...acct, prefs: { vibe: "nope" } }, null, new Date(2026, 7, 18)).vibe.id === "easy",
);

/* ── ranking ─────────────────────────────────────────────────────────────── */

section("what feeds you for days, and what merely keeps");
const cookies = dish({ id: "cookies", cat: "dessert", feeds_days: 4, minutes: 30 });
const chili = dish({ id: "chili", cat: "dinner", feeds_days: 4, method: "crockpot", minutes: 300 });
check("a tray of cookies is not a week of dinners", !feedsAllWeek(cookies));
check("a pot of chili is", feedsAllWeek(chili));
check(
  "and it outranks the cookies on a cook-for-the-week day",
  moodScore(chili, sunday, acct) > moodScore(cookies, sunday, acct),
);

section("the vibe reorders, and the day it is for wins");
const quick = dish({ id: "quick", minutes: 15, effort: "quick" });
const project = dish({ id: "project", minutes: 180, effort: "project" });
check(
  "Tuesday prefers the fast one",
  moodScore(quick, tuesday, acct) > moodScore(project, tuesday, acct),
);
const proper = moodFor({ ...acct, prefs: { vibe: "proper" } }, null, new Date(2026, 7, 15));
check(
  "cook-something-proper prefers the project",
  moodScore(project, proper, acct) > moodScore(quick, proper, acct),
);

const nachos = dish({ id: "nachos", cat: "snack", occasions: ["gameday"], minutes: 25 });
const gameday = moodFor({ ...acct, prefs: { vibe: "gameday" } }, null, new Date(2026, 9, 11));
check(
  "on game day the snack finally beats the dinner",
  moodScore(nachos, gameday, acct) > moodScore(quick, gameday, acct),
);
check(
  "and on a Tuesday it does not",
  moodScore(nachos, tuesday, acct) < moodScore(quick, tuesday, acct),
);

section("standing preferences nudge, they do not decide");
const grilled = dish({ id: "grilled", method: "grill", minutes: 30, effort: "quick" });
const avoided = { ...acct, prefs: { avoid_methods: ["grill"] } };
check(
  "a method the house avoids sinks",
  moodScore(grilled, tuesday, avoided) < moodScore(grilled, tuesday, acct),
);
const fancy = dish({ id: "fancy", spend: 3, minutes: 40 });
check(
  "ball-out mode lifts the expensive dish",
  moodScore(fancy, tuesday, { ...acct, prefs: { mode: "ballout" } }) >
    moodScore(fancy, tuesday, acct),
);
check(
  "meal-prep mode lifts the pot of chili",
  moodScore(chili, tuesday, { ...acct, prefs: { mode: "prep" } }) > moodScore(chili, tuesday, acct),
);

section("in season");
const august = dish({ id: "corn", season: [7, 8, 9], minutes: 30 });
const yearRound = dish({ id: "plain", minutes: 30 });
const aug = moodFor(acct, null, new Date(2026, 7, 18, 18));
const feb = moodFor(acct, null, new Date(2026, 1, 17, 18));
check(
  "an August dish beats a year-round one in August",
  moodScore(august, aug, acct) > moodScore(yearRound, aug, acct),
);
check("and does not in February", moodScore(august, feb, acct) === moodScore(yearRound, feb, acct));

section("every vibe is reachable and scores something");
for (const v of VIBES) {
  const m = moodFor({ ...acct, prefs: { vibe: v.id } }, null, new Date(2026, 7, 18));
  if (m.vibe.id !== v.id) check(`${v.id} resolves`, false);
}
check("all seven resolve", true);
