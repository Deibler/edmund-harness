/**
 * The time a message names, as windows recall can search inside.
 *
 * Per-turn recall ranks by meaning, weighted toward recent, so a question
 * about an older moment loses to newer talk on the same subject. On
 * 2026-10-26 "Send me the clip of the meteor fireball from June" got the
 * August and September fireballs; the June one (a 06-03 message calling it a
 * satellite) came up only when the search was limited to June. LongMemEval
 * (ICLR 2025) measured the same effect: narrowing retrieval to the time a
 * question names raised recall 7-11% on temporal questions.
 *
 * Deliberately narrow. A month counts when the wording marks it as a time
 * ("in June", "back in May", "early August", "June 3", "Aug 30, 2026"), so
 * "you may" or "march over" do not. A numeric date counts after "on", "from"
 * or "since" ("on 8/30"), so "1/4 of the bake" does not. Relative phrases
 * count when they reach back further than the conversation still shows:
 * "N days/weeks/months ago", "last week", "last month". "Yesterday" and
 * "last night" are left out: those messages are still in front of the model.
 */
import { homeWallClockMs } from "../util/clock.ts";

export type TimeWindow = { sinceMs: number; untilMs: number; label: string };

const DAY = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";
const MONTH_NAMES = [
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
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  couple: 2,
  few: 3,
};

/** "June 3" or "in June", with an optional early/mid/late and year. */
const MONTH_PHRASE = new RegExp(
  `\\b(?:(in|from|back in|during|since|of|around|early|mid|late|last)\\s+(?:(early|mid|late)\\s+)?)?${MONTH_RE}\\.?(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b)?(?:,?\\s+(20\\d{2}))?`,
  "gi",
);
const NUMERIC_DATE = /\b(on|from|since|back on|around)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/gi;
const AGO =
  /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a couple|couple of|a few|few)\s+(day|week|month)s?\s+ago\b/gi;
const LAST_UNIT = /\blast\s+(week|month)\b/gi;

/** Eastern calendar date for an instant. */
function easternYmd(ms: number): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: n("year"), m: n("month"), d: n("day") };
}

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.toLowerCase().slice(0, 3));
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Windows for the times `text` names, as of `nowMs`. A month or date without
 * a year means its most recent occurrence that is not in the future. Windows
 * that would end in the future are clipped to now; none reaches back more
 * than `maxDays`.
 */
export function timeWindowsIn(text: string, nowMs: number, maxDays = 365): TimeWindow[] {
  const today = easternYmd(nowMs);
  const out: TimeWindow[] = [];
  const add = (sinceMs: number, untilMs: number, label: string) => {
    const until = Math.min(untilMs, nowMs);
    if (until <= sinceMs || until < nowMs - maxDays * DAY) return;
    if (!out.some((w) => w.sinceMs === sinceMs && w.untilMs === until)) {
      out.push({ sinceMs, untilMs: until, label });
    }
  };

  for (const m of text.matchAll(MONTH_PHRASE)) {
    const [, lead, part, monthWord, dayStr, yearStr] = m;
    const mi = monthIndex(monthWord!);
    if (mi < 0) continue;
    const day = dayStr ? Number(dayStr) : null;
    const modifier = (
      part ?? (lead && /^(early|mid|late)$/i.test(lead) ? lead : null)
    )?.toLowerCase();
    // A bare month word is a time only when something marks it as one.
    // "last June" reads as the most recent June, the same as "in June".
    if (!lead && !day && !yearStr) continue;
    let year = yearStr ? Number(yearStr) : today.y;
    const month = mi + 1;
    if (!yearStr && (month > today.m || (month === today.m && day !== null && day > today.d))) {
      year -= 1;
    }
    if (day !== null) {
      if (day < 1 || day > daysInMonth(year, month)) continue;
      // A day, with a day either side for late nights and loose memory.
      const start = homeWallClockMs(year, month, day) - DAY;
      add(start, start + 3 * DAY, `${MONTH_NAMES[mi]} ${day}`);
      continue;
    }
    const last = daysInMonth(year, month);
    const [from, to] =
      modifier === "early"
        ? [1, 11]
        : modifier === "mid"
          ? [10, 21]
          : modifier === "late"
            ? [20, last]
            : [1, last];
    const since = homeWallClockMs(year, month, from);
    const until = homeWallClockMs(year, month, to) + DAY;
    add(
      since,
      until,
      `${modifier ? `${modifier} ` : ""}${MONTH_NAMES[mi]}${yearStr ? ` ${year}` : ""}`,
    );
  }

  for (const m of text.matchAll(NUMERIC_DATE)) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12) continue;
    let year = m[4] ? Number(m[4].length === 2 ? `20${m[4]}` : m[4]) : today.y;
    if (!m[4] && (month > today.m || (month === today.m && day > today.d))) year -= 1;
    if (day < 1 || day > daysInMonth(year, month)) continue;
    const start = homeWallClockMs(year, month, day) - DAY;
    add(start, start + 3 * DAY, `${MONTH_NAMES[month - 1]} ${day}`);
  }

  for (const m of text.matchAll(AGO)) {
    const word = m[1]!.toLowerCase().replace(/^(a )?(couple|few)( of)?$/, "$2");
    const n = /^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word] ?? Number.NaN);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = m[2]!.toLowerCase();
    const span = unit === "day" ? DAY : unit === "week" ? 7 * DAY : 30 * DAY;
    // Memory of "three weeks ago" is loose: a unit either side.
    add(nowMs - (n + 1) * span, nowMs - Math.max(0, n - 1) * span, `${m[1]} ${unit}s ago`);
  }

  for (const m of text.matchAll(LAST_UNIT)) {
    const unit = m[1]!.toLowerCase();
    if (unit === "week") {
      add(nowMs - 14 * DAY, nowMs - 5 * DAY, "last week");
    } else {
      const y = today.m === 1 ? today.y - 1 : today.y;
      const month = today.m === 1 ? 12 : today.m - 1;
      add(
        homeWallClockMs(y, month, 1),
        homeWallClockMs(today.y, today.m, 1),
        `last month (${MONTH_NAMES[month - 1]})`,
      );
    }
  }
  return out;
}
