/**
 * What kind of day it is, and therefore what the kitchen should be offering.
 *
 * The complaint this answers is that a meal page goes stale: the same twelve
 * dinners, ranked the same way, in February and in July, on a Tuesday after
 * work and on the Sunday of a holiday weekend. A list that never changes is a
 * list you stop opening, and by then the fact that it was CORRECT is worth
 * nothing.
 *
 * So the home page reads the day before it ranks anything. Four signals, in
 * descending order of how sure we can be:
 *
 *   1. THE CALENDAR is arithmetic. The month, the weekday, whether it is a
 *      weekend, which holiday is close, whether football is on. None of this
 *      can be wrong and none of it needs a network.
 *   2. THE WEATHER is fetched and CACHED, and its absence is a first-class
 *      state. If nobody has refreshed it, or the household has no coordinates,
 *      the page says nothing about weather rather than guessing at a season's
 *      typical temperature. Inventing a plausible 78 degrees is exactly the
 *      class of lie the rest of this integration refuses to tell.
 *   3. THE HOUSEHOLD'S OWN PREFERENCE overrides both, because somebody saying
 *      "this week we are meal prepping" knows something the calendar doesn't.
 *   4. THE LEDGER decides what is actually cookable, which happens downstream
 *      and is not this module's business.
 *
 * Everything here RANKS and never FILTERS. A mood that hides food is a mood
 * that gets switched off the first time it hides the thing you wanted, and
 * then the page is a plain list again.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";
import { type Recipe, effortOf, feedsAllWeek, inSeason } from "./recipes.ts";
import type { Account } from "./types.ts";

/* ── weather ─────────────────────────────────────────────────────────────── */

export type Weather = {
  /** When this was fetched. */
  at: string;
  /** Temperature now, Fahrenheit. */
  tempF: number;
  /** Today's high and low where the forecast gives them. */
  highF: number | null;
  lowF: number | null;
  /** NWS short forecast, e.g. "Mostly Sunny". */
  short: string;
  /** Percent chance of precipitation, when the forecast states one. */
  precip: number | null;
  place: string | null;
};

function weatherPath(account: string): string {
  return join(accountDir(), account, "weather.json");
}

/**
 * The cached reading, or null.
 *
 * Twelve hours is the staleness limit and it is deliberately generous: this
 * drives a sentence and a ranking nudge, not a decision anyone acts on. Past
 * that it returns null and the page falls silent about weather, which is the
 * correct behaviour and the reason every caller treats null as ordinary.
 */
export function readWeather(account: string, maxAgeHours = 12): Weather | null {
  const p = weatherPath(account);
  if (!existsSync(p)) return null;
  try {
    const w = JSON.parse(readFileSync(p, "utf8")) as Weather;
    const age = (Date.now() - new Date(w.at).getTime()) / 3_600_000;
    return age <= maxAgeHours && typeof w.tempF === "number" ? w : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the current conditions for a household that has coordinates.
 *
 * Returns null rather than throwing when the household has no `place`, because
 * having no coordinates is a normal state and not an error. NWS wants a real
 * user agent and answers with a two-step: points, then the gridpoint forecast.
 */
export async function refreshWeather(
  account: string,
  acct: Account,
  minAgeMinutes = 40,
): Promise<Weather | null> {
  const place = acct.place;
  if (!place || typeof place.lat !== "number" || typeof place.lon !== "number") return null;
  // The drain calls this on every pass, seconds apart, and three NWS requests per
  // pass per household is tens of thousands of calls a day for a sentence that
  // changes on the hour. A reading younger than this is simply handed back.
  const fresh = readWeather(account, minAgeMinutes / 60);
  if (fresh) return fresh;
  const ua = { "User-Agent": "edmund-harness kitchen (contact@example.com)" };
  const pts = await fetch(
    `https://api.weather.gov/points/${place.lat.toFixed(4)},${place.lon.toFixed(4)}`,
    { headers: ua },
  );
  if (!pts.ok) throw new Error(`weather points ${pts.status}`);
  const pj = (await pts.json()) as {
    properties: {
      forecastHourly: string;
      forecast: string;
      relativeLocation?: { properties?: { city?: string; state?: string } };
    };
  };
  const [hourly, daily] = await Promise.all([
    fetch(pj.properties.forecastHourly, { headers: ua }),
    fetch(pj.properties.forecast, { headers: ua }),
  ]);
  if (!hourly.ok) throw new Error(`weather hourly ${hourly.status}`);
  const hj = (await hourly.json()) as {
    properties: {
      periods: Array<{
        temperature: number;
        shortForecast: string;
        probabilityOfPrecipitation?: { value: number | null };
      }>;
    };
  };
  const now = hj.properties.periods[0];
  if (!now) return null;

  let highF: number | null = null;
  let lowF: number | null = null;
  if (daily.ok) {
    const dj = (await daily.json()) as {
      properties: { periods: Array<{ isDaytime: boolean; temperature: number }> };
    };
    const next = dj.properties.periods.slice(0, 2);
    highF = next.find((p) => p.isDaytime)?.temperature ?? null;
    lowF = next.find((p) => !p.isDaytime)?.temperature ?? null;
  }

  const rel = pj.properties.relativeLocation?.properties;
  const w: Weather = {
    at: new Date().toISOString(),
    tempF: now.temperature,
    highF,
    lowF,
    short: now.shortForecast,
    precip: now.probabilityOfPrecipitation?.value ?? null,
    place: place.label ?? (rel?.city ? `${rel.city}, ${rel.state ?? ""}`.trim() : null),
  };
  mkdirSync(join(accountDir(), account), { recursive: true });
  writeFileSync(weatherPath(account), JSON.stringify(w, null, 2));
  return w;
}

/* ── the calendar ────────────────────────────────────────────────────────── */

export type SeasonName = "winter" | "spring" | "summer" | "fall";

export function seasonOf(d: Date): SeasonName {
  const m = d.getMonth() + 1;
  if (m <= 2 || m === 12) return "winter";
  if (m <= 5) return "spring";
  if (m <= 8) return "summer";
  return "fall";
}

const nth = (year: number, month: number, weekday: number, n: number): Date => {
  const first = new Date(year, month - 1, 1);
  const shift = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month - 1, 1 + shift + (n - 1) * 7);
};

const lastOf = (year: number, month: number, weekday: number): Date => {
  const last = new Date(year, month, 0);
  return new Date(year, month - 1, last.getDate() - ((last.getDay() - weekday + 7) % 7));
};

/** Anonymous Gregorian computus. Easter moves and half the spring hangs off it. */
function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return new Date(year, month - 1, ((h + l - 7 * m + 114) % 31) + 1);
}

export type Occasion = {
  id: string;
  label: string;
  date: Date;
  /** Days out at which it starts showing up. Cooking starts before the day. */
  lead: number;
  /** What food it means. Matched against a recipe's `occasions`. */
  tags: string[];
};

/** Every occasion this calendar knows, for one year. */
export function occasionsIn(year: number): Occasion[] {
  const o = (id: string, label: string, date: Date, lead: number, tags: string[]): Occasion => ({
    id,
    label,
    date,
    lead,
    tags,
  });
  const labor = nth(year, 9, 1, 1);
  // The NFL opens the Thursday after Labor Day. Close enough to be useful and
  // it never claims to know a schedule it has not been told.
  const kickoff = new Date(labor.getFullYear(), labor.getMonth(), labor.getDate() + 3);
  return [
    o("newyear", "New Year's Day", new Date(year, 0, 1), 1, ["holiday", "party"]),
    o("superbowl", "Super Bowl Sunday", nth(year, 2, 0, 2), 3, ["gameday", "party"]),
    o("valentines", "Valentine's Day", new Date(year, 1, 14), 2, ["holiday", "date"]),
    o("stpatricks", "St Patrick's Day", new Date(year, 2, 17), 2, ["holiday"]),
    o("easter", "Easter", easter(year), 3, ["holiday", "sunday"]),
    o("memorial", "Memorial Day", lastOf(year, 5, 1), 3, ["holiday", "cookout"]),
    o("july4", "the Fourth", new Date(year, 6, 4), 3, ["holiday", "cookout", "party"]),
    o("labor", "Labor Day", labor, 3, ["holiday", "cookout"]),
    o("kickoff", "opening weekend", kickoff, 4, ["gameday", "party"]),
    o("halloween", "Halloween", new Date(year, 9, 31), 3, ["holiday", "party"]),
    o("thanksgiving", "Thanksgiving", nth(year, 11, 4, 4), 6, ["holiday", "project"]),
    o("christmas", "Christmas", new Date(year, 11, 25), 7, ["holiday", "project"]),
    o("nye", "New Year's Eve", new Date(year, 11, 31), 3, ["holiday", "party"]),
  ];
}

const DAY = 86_400_000;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The nearest occasion inside its own lead window, if any. */
export function occasionNow(d: Date): { occ: Occasion; daysOut: number } | null {
  const near = [...occasionsIn(d.getFullYear()), ...occasionsIn(d.getFullYear() + 1)]
    .map((occ) => ({ occ, daysOut: Math.round((midnight(occ.date) - midnight(d)) / DAY) }))
    .filter((x) => x.daysOut >= 0 && x.daysOut <= x.occ.lead)
    .sort((a, b) => a.daysOut - b.daysOut);
  return near[0] ?? null;
}

/** Football season, roughly: college opens late August, the run ends mid-February. */
export function footballOn(d: Date): boolean {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (m >= 9 && m <= 12) return true;
  if (m === 8 && day >= 24) return true;
  return m === 1 || (m === 2 && day <= 15);
}

/* ── vibes ───────────────────────────────────────────────────────────────── */

export type Vibe = {
  id: string;
  label: string;
  /** The sentence under the heading. Written to be read, not parsed. */
  blurb: string;
};

/**
 * The moods a kitchen can be in.
 *
 * Deliberately few and deliberately overlapping: this is a dial somebody turns
 * when the page has misread the day, not a taxonomy. Order matters, because
 * the refresh button walks it.
 */
export const VIBES: Vibe[] = [
  { id: "easy", label: "Keep it easy", blurb: "On the table fast, nothing to think about." },
  { id: "proper", label: "Cook something proper", blurb: "Time to actually cook. The good pans." },
  { id: "allweek", label: "Feed us all week", blurb: "Cook once, eat it for days." },
  { id: "ballout", label: "Ball out", blurb: "The good stuff. Cost is not the point tonight." },
  { id: "light", label: "Light and fast", blurb: "Nothing heavy, nothing that heats the house." },
  { id: "cozy", label: "Cozy", blurb: "Oven on, something that simmers." },
  { id: "gameday", label: "Game day", blurb: "Food you eat standing up with the TV on." },
];

export const vibeById = (id: string | null | undefined): Vibe | null =>
  VIBES.find((v) => v.id === id) ?? null;

/* ── the mood ────────────────────────────────────────────────────────────── */

export type Signal = { id: string; label: string };

export type Mood = {
  /** ISO day this was computed for. */
  day: string;
  month: number;
  season: SeasonName;
  weekend: boolean;
  /** The big line at the top of the page. */
  headline: string;
  /** One sentence saying why the list looks like it does. */
  line: string;
  /** Chips: what the page noticed today. */
  signals: Signal[];
  /** The vibe in force, and whether a person pinned it. */
  vibe: Vibe;
  pinned: boolean;
  /** What the day would have chosen on its own, for the "let the day decide" copy. */
  auto: Vibe;
  weather: Weather | null;
  occasion: { id: string; label: string; daysOut: number; tags: string[] } | null;
  football: boolean;
};

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Which vibe the day itself argues for.
 *
 * Ordered by how strong the claim is. A holiday beats the weather; the weather
 * beats the weekday; the weekday is the fallback and is right most of the time,
 * because most days are Tuesday.
 */
function autoVibe(d: Date, w: Weather | null, acct: Account): Vibe {
  const dow = d.getDay();
  const weekend = dow === 0 || dow === 6;
  const occ = occasionNow(d);
  const prepDays = (acct.schedule?.prep_days ?? []).map((s) => s.toLowerCase());

  if (occ?.occ.tags.includes("gameday")) return vibeById("gameday")!;
  if (occ?.occ.tags.includes("project") && occ.daysOut <= 1) return vibeById("proper")!;
  if (occ?.occ.tags.includes("party") || occ?.occ.tags.includes("cookout")) {
    return vibeById("ballout")!;
  }
  if (prepDays.includes(WEEKDAY[dow]!.toLowerCase())) return vibeById("allweek")!;
  if (footballOn(d) && dow === 0) return vibeById("gameday")!;
  if (w && w.tempF >= 85) return vibeById("light")!;
  if (w && w.tempF <= 38) return vibeById("cozy")!;
  if (dow === 0) return vibeById("allweek")!;
  if (weekend) return vibeById("proper")!;
  return vibeById("easy")!;
}

/** A sentence about the weather, or nothing at all. Never a guess. */
function weatherLine(w: Weather | null): string {
  if (!w) return "";
  const t = Math.round(w.tempF);
  const sky = w.short.toLowerCase();
  if (t >= 88) return `It is ${t} and ${sky}, so nothing that runs the oven for an hour.`;
  if (t >= 78) return `It is ${t} out and ${sky}.`;
  if (t <= 34) return `It is ${t} and ${sky}, which is soup and oven weather.`;
  if (t <= 50) return `It is ${t} and ${sky}, cold enough to want something that simmers.`;
  if ((w.precip ?? 0) >= 60) return `It is ${t} with rain around, an indoors kind of dinner.`;
  return `It is ${t} and ${sky}.`;
}

export function moodFor(acct: Account, weather: Weather | null, now = new Date()): Mood {
  const dow = now.getDay();
  const weekend = dow === 0 || dow === 6 || (dow === 5 && now.getHours() >= 16);
  const occ = occasionNow(now);
  const auto = autoVibe(now, weather, acct);
  const pinnedVibe = vibeById(acct.prefs?.vibe);
  const vibe = pinnedVibe ?? auto;

  const signals: Signal[] = [];
  if (occ) {
    signals.push({
      id: occ.occ.id,
      label:
        occ.daysOut === 0
          ? occ.occ.label
          : occ.daysOut === 1
            ? `${occ.occ.label} tomorrow`
            : `${occ.occ.label} in ${occ.daysOut} days`,
    });
  }
  if (footballOn(now)) signals.push({ id: "football", label: "Football season" });
  signals.push({ id: `season-${seasonOf(now)}`, label: MONTH[now.getMonth()]! });
  if (weekend) signals.push({ id: "weekend", label: dow === 0 ? "Sunday" : "Weekend" });
  if (weather) {
    signals.push({
      id: "weather",
      label: `${Math.round(weather.tempF)} and ${weather.short.toLowerCase()}`,
    });
  }
  const mode = acct.prefs?.mode;
  if (mode === "prep") signals.push({ id: "mode-prep", label: "Meal prep week" });
  if (mode === "ballout") signals.push({ id: "mode-ballout", label: "Ball out" });

  const headline =
    occ && occ.daysOut === 0 ? occ.occ.label : `${WEEKDAY[dow]} in ${MONTH[now.getMonth()]}`;

  const bits = [
    occ && occ.daysOut > 0
      ? `${occ.occ.label} is ${occ.daysOut === 1 ? "tomorrow" : `${occ.daysOut} days out`}.`
      : "",
    weatherLine(weather),
    vibe.blurb,
  ].filter(Boolean);

  return {
    day: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    month: now.getMonth() + 1,
    season: seasonOf(now),
    weekend,
    headline,
    line: bits.join(" "),
    signals,
    vibe,
    pinned: !!pinnedVibe,
    auto,
    weather,
    occasion: occ
      ? { id: occ.occ.id, label: occ.occ.label, daysOut: occ.daysOut, tags: occ.occ.tags }
      : null,
    football: footballOn(now),
  };
}

/* ── ranking ─────────────────────────────────────────────────────────────── */

/**
 * How well a dish fits today, as a number that only means anything next to
 * another one from the same call.
 *
 * A nudge, never a gate. The largest term here is worth less than being
 * cookable from what is on the shelves, which is applied by the caller, so at
 * its most opinionated this reorders dinners you could already have made.
 */
/**
 * What kind of dish this is, as a standing penalty.
 *
 * The catalog already ranks meal kinds so that a bowl of grapes cannot lead a
 * page asking what is for dinner, and the mood must not quietly undo that. It
 * can still be OUT-VOTED: a game day vibe lifts snacks by more than this takes
 * away, which is the one day they belong at the top.
 */
const KIND: Record<string, number> = {
  dinner: 0,
  lunch: -4,
  compound: -4,
  lighter: -8,
  breakfast: -10,
  side: -14,
  snack: -22,
  dessert: -26,
};

export function moodScore(r: Recipe, mood: Mood, acct: Account): number {
  let s = KIND[r.cat] ?? -8;
  const effort = effortOf(r);
  const mode = acct.prefs?.mode ?? "normal";

  switch (mood.vibe.id) {
    case "easy":
      s += effort === "quick" ? 30 : effort === "weeknight" ? 14 : -18;
      s += r.minutes <= 30 ? 10 : 0;
      break;
    case "proper":
      s += effort === "project" ? 30 : effort === "allday" ? 22 : effort === "weeknight" ? 6 : -10;
      break;
    case "allweek":
      s += feedsAllWeek(r) ? 34 : -6;
      s += (r.feeds_days ?? 1) >= 4 ? 10 : 0;
      s += r.method === "crockpot" ? 10 : 0;
      break;
    case "ballout":
      s += (r.spend ?? 2) === 3 ? 30 : (r.spend ?? 2) === 2 ? 8 : -10;
      s += effort === "project" || effort === "allday" ? 10 : 0;
      break;
    case "light":
      s += (r.health ?? 3) >= 4 ? 22 : 0;
      s += r.method === "nocook" ? 20 : r.method === "grill" ? 12 : 0;
      s += r.method === "oven" ? -14 : 0;
      s += r.minutes <= 30 ? 8 : 0;
      break;
    case "cozy":
      s += r.method === "crockpot" ? 24 : r.method === "oven" ? 18 : 0;
      s += (r.occasions ?? []).includes("cozy") ? 18 : 0;
      s += effort === "quick" ? -6 : 0;
      break;
    case "gameday":
      s += (r.occasions ?? []).includes("gameday") ? 34 : 0;
      s += r.cat === "snack" ? 22 : 0;
      s += (r.occasions ?? []).includes("party") ? 10 : 0;
      break;
  }

  if (inSeason(r, mood.month)) s += 16;
  for (const tag of mood.occasion?.tags ?? []) {
    if ((r.occasions ?? []).includes(tag)) s += 20;
  }
  if (mood.weekend && (r.occasions ?? []).includes("weekend")) s += 10;
  if (mood.football && (r.occasions ?? []).includes("gameday")) s += 8;

  // The household's standing mode, applied on top of the day's vibe. Smaller
  // than the vibe on purpose: it is a background preference, not tonight's
  // decision, and it should not be able to out-vote what somebody just tapped.
  if (mode === "prep") s += feedsAllWeek(r) ? 14 : 0;
  if (mode === "ballout") s += ((r.spend ?? 2) - 2) * 10;
  if (acct.prefs?.per_meal != null && (r.spend ?? 2) === 3 && acct.prefs.per_meal < 15) s -= 12;
  if ((acct.prefs?.avoid_methods ?? []).includes(r.method ?? "")) s -= 40;
  if (acct.diet?.style === "high-protein" && (r.health ?? 3) >= 4) s += 4;

  return s;
}

/** The next vibe in the rotation, for the refresh button. Wraps. */
export function nextVibe(current: string | null | undefined): string {
  const i = VIBES.findIndex((v) => v.id === current);
  return VIBES[(i + 1) % VIBES.length]!.id;
}
