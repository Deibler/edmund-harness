/**
 * Standing dinner texts ("text us at four what we are having").
 *
 * The text has to arrive, so the pick is deterministic: the same ranking the
 * home page runs, from the ledger and the clock alone, sent by the watch pass
 * with no model in the delivery path. If the dish has never been written out,
 * firing also queues the request a "Make this" tap would, so a written page can
 * follow; the text never waits on it.
 *
 * A missed window is skipped, never fired late. Firing opens no plan and
 * consumes nothing: being told what to cook is not evidence anybody cooked it.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eaters, getAccount, updateAccount } from "./accounts.ts";
import { loadCookbook } from "./cookbook.ts";
import { fitScore } from "./fit.ts";
import { isConvenience } from "./foods.ts";
import { lastMade, madeIndex } from "./made.ts";
import { moodFor, moodScore, readWeather } from "./mood.ts";
import { loadProfiles } from "./profile.ts";
import { type Cookable, type Recipe, cookable, menu } from "./recipes.ts";
import { fold, live } from "./store.ts";
import type { Account } from "./types.ts";

/** Which meal a standing text is about. */
export const MEALS = ["dinner", "lunch", "breakfast"] as const;
export type MealKind = (typeof MEALS)[number];

/**
 * Categories each meal may propose. Not `MEAL_CATS`, which answers a different
 * question and admits lunch. The relation is one-way: a dinner can be lunch, a
 * lunch is never dinner.
 */
const CATS_FOR: Record<MealKind, Set<string>> = {
  dinner: new Set(["dinner", "compound"]),
  lunch: new Set(["lunch", "dinner", "compound"]),
  breakfast: new Set(["breakfast", "lighter"]),
};

export type Dinner = {
  id: string;
  /** "HH:MM", local. */
  at: string;
  /** 0=Sunday .. 6=Saturday. Empty means every day. */
  days: number[];
  /** Principals to text. Empty means everybody who eats here. */
  to: string[];
  meal: MealKind;
  /** A standing steer, e.g. "something quick". Advisory, never a filter. */
  note?: string | null;
  on: boolean;
  created: string;
  /** Local YYYY-MM-DD this last fired, so a restart cannot re-send today's. */
  fired?: string | null;
  /**
   * Who has received today's, as `YYYY-MM-DD|principal`. Per person because
   * sends fail per person: a retry inside the grace window reaches only those
   * still owed, and nobody gets a second copy.
   */
  sent?: string[];
  /** ISO of the last send, for "last sent" on the page. */
  last?: string | null;
  /** What this schedule suggested recently, newest last, so it does not repeat itself. */
  picks?: Array<{ day: string; recipe: string }>;
};

/** Days a suggested dish is held back from the same schedule. */
export const REPEAT_DAYS = 7;
/** How many past picks a schedule remembers. */
const PICKS_KEPT = 14;

/** Minutes late a fire may still be sent: survives a closed lid, still about tonight. */
export const GRACE_MIN = 75;

const DAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function dinnersOf(acct: Account): Dinner[] {
  return (acct.dinners ?? []).slice().sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Coerce input into a valid schedule, or refuse it. Every write path (site, tool,
 * registry edit) goes through here, chiefly so `to` can never name somebody
 * outside the household. Rebuilt from a fixed field list: a new `Dinner` field
 * must be carried here too.
 */
export function normalize(
  raw: Partial<Dinner> & { id?: string },
  acct: Account,
  now = new Date(),
): Dinner {
  const at = String(raw.at ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!m) throw new Error(`"${at}" is not a time. Use 24-hour HH:MM, e.g. 16:00.`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`${at} is not a real time of day.`);

  const meal = MEALS.includes(raw.meal as MealKind) ? (raw.meal as MealKind) : "dinner";
  const days = [...new Set((raw.days ?? []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();

  const household = new Set(eaters(acct).map((e) => e.principal));
  const asked = (raw.to ?? []).filter((p) => typeof p === "string" && p.trim());
  const strangers = asked.filter((p) => !household.has(p));
  if (strangers.length) {
    throw new Error(
      `${strangers.join(", ")} ${strangers.length === 1 ? "does" : "do"} not live here. ` +
        `A schedule can only text this household: ${[...household].join(", ")}.`,
    );
  }

  return {
    id: raw.id?.trim() || `d${Math.abs(hash(`${at}|${meal}|${days.join("")}|${asked.join("")}`))}`,
    at: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
    days,
    to: asked,
    meal,
    note: raw.note?.trim() || null,
    on: raw.on !== false,
    created: raw.created ?? now.toISOString(),
    fired: raw.fired ?? null,
    // Only today's receipts matter; older ones would grow forever.
    sent: (raw.sent ?? []).filter((s) => typeof s === "string" && s.startsWith(dayKeyOf(now))),
    last: raw.last ?? null,
    picks: (raw.picks ?? []).slice(-PICKS_KEPT),
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * What an edited schedule keeps from its previous row: when it was made, when it
 * last fired and what it recently suggested. Every edit path spreads this, so a
 * field added here cannot be dropped by one path and kept by another.
 */
export function carriedOver(was: Dinner | undefined): {
  created: string;
  fired: string | null;
  last: string | null;
  picks: Dinner["picks"];
} {
  return {
    created: was?.created ?? new Date().toISOString(),
    fired: was?.fired ?? null,
    last: was?.last ?? null,
    picks: was?.picks ?? [],
  };
}

export function saveDinners(account: string, list: Dinner[]): Dinner[] {
  updateAccount(account, { dinners: list });
  return list;
}

/** Everyone a schedule texts, resolved. An empty `to` means the whole house. */
export function recipients(d: Dinner, acct: Account): Array<{ principal: string; label: string }> {
  const all = eaters(acct);
  if (!d.to.length) return all;
  return all.filter((e) => d.to.includes(e.principal));
}

/** Plain English, for the site, the tool and the log. */
export function describe(d: Dinner, acct: Account): string {
  const when =
    d.days.length === 0
      ? "every day"
      : d.days.length === 7
        ? "every day"
        : sameSet(d.days, [1, 2, 3, 4, 5])
          ? "weekdays"
          : sameSet(d.days, [0, 6])
            ? "weekends"
            : d.days.map((n) => SHORT_DAY[n]).join(", ");
  const who = recipients(d, acct).map((e) => e.label);
  const to =
    who.length === 0
      ? "nobody"
      : who.length === 1
        ? who[0]!
        : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}`;
  return `${clock(d.at)} ${when}, ${d.meal} to ${to}${d.note ? `, steer: "${d.note}"` : ""}${d.on ? "" : " (paused)"}`;
}

const sameSet = (a: number[], b: number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** 24-hour storage, 12-hour display. */
export function clock(at: string): string {
  const [h, m] = at.split(":").map(Number) as [number, number];
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

const dayKeyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Whether the window is open now: on, today, not yet fired, and within `GRACE_MIN`. */
export function dueNow(d: Dinner, now = new Date()): boolean {
  if (!d.on) return false;
  if (d.days.length && !d.days.includes(now.getDay())) return false;
  if (d.fired === dayKeyOf(now)) return false;
  const [h, m] = d.at.split(":").map(Number) as [number, number];
  const mins = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
  return mins >= 0 && mins <= GRACE_MIN;
}

/** Today's receipt for one person, the key `sent` is keyed by. */
const receipt = (principal: string, now: Date) => `${dayKeyOf(now)}|${principal}`;

/** Who this schedule still owes a text today. */
export function owed(
  d: Dinner,
  acct: Account,
  now = new Date(),
): Array<{ principal: string; label: string }> {
  const done = new Set(d.sent ?? []);
  return recipients(d, acct).filter((p) => !done.has(receipt(p.principal, now)));
}

/** The next time this will fire, as a Date, ignoring today if today has gone. */
export function nextFire(d: Dinner, now = new Date()): Date | null {
  if (!d.on) return null;
  const [h, m] = d.at.split(":").map(Number) as [number, number];
  for (let ahead = 0; ahead <= 7; ahead++) {
    const when = new Date(now);
    when.setDate(now.getDate() + ahead);
    when.setHours(h, m, 0, 0);
    if (when.getTime() <= now.getTime()) continue;
    if (d.days.length && !d.days.includes(when.getDay())) continue;
    return when;
  }
  return null;
}

/* ── picking ─────────────────────────────────────────────────────────────── */

export type Pick = {
  recipe: Recipe;
  ready: boolean;
  /** Ingredient names the shelves are short of, in a shopper's words. */
  missing: string[];
  /** Whether a full recipe page already exists for it. */
  written: boolean;
  lastMade: string | null;
};

/**
 * Tonight's pick, from the ledger alone. The same terms the home page ranks by,
 * so the text and the page agree: cookable first, then fit to the day and the
 * household's history. Recent dishes are pushed down, never removed.
 */
export function pickFor(
  account: string,
  acct: Account,
  meal: MealKind = "dinner",
  now = new Date(),
  /** Recipe ids this schedule suggested in the last `REPEAT_DAYS`. */
  recent: ReadonlySet<string> = new Set(),
): Pick | null {
  const items = fold(account);
  const written = new Set(loadCookbook(account).map((b) => b.id));

  const cats = CATS_FOR[meal];
  // A dinner built around deli meat or bread is lunch, whatever its card says.
  const anchoredOnLunch = (r: Recipe) => {
    const main = items[r.needs[0]?.[0] ?? ""];
    return meal === "dinner" && !!main && isConvenience(main);
  };
  // The same menu the home page ranks, so the avoid list holds here too.
  const all = menu(account).filter((r) => cats.has(r.cat) && !anchoredOnLunch(r));
  if (!all.length) return null;

  const mood = moodFor(acct, readWeather(account), now);
  const made = madeIndex(account);

  const prof = loadProfiles(account);

  const scored = cookable(items, all)
    .map((c: Cookable) => {
      const when = lastMade(made, c.recipe) ?? null;
      return {
        c,
        when,
        score:
          (c.ready ? 1000 : 0) +
          // A dish written for this meal beats one merely allowed into the pool.
          (c.recipe.cat === meal ? 45 : 0) +
          // One missing item is a stop at the shop; four is a different dinner.
          -12 * c.missing.length +
          // Suggested by this text in the last week: say something else.
          (recent.has(c.recipe.id) ? -60 : 0) +
          moodScore(c.recipe, mood, acct) +
          // The same fit function the home page uses, so the two cannot drift.
          fitScore(c.recipe, items, made, prof, now),
      };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return null;
  return {
    recipe: top.c.recipe,
    ready: top.c.ready,
    missing: top.c.missing.map((n) => n.name),
    written: written.has(top.c.recipe.id),
    lastMade: top.when,
  };
}

/* ── the text ────────────────────────────────────────────────────────────── */

const MEAL_WORD: Record<MealKind, string> = {
  dinner: "Tonight",
  lunch: "Lunch",
  breakfast: "Breakfast",
};

/** The text itself: deterministic prose that never claims food the house lacks. */
export function composeText(
  pick: Pick | null,
  d: Dinner,
  acct: Account,
  url: string | null,
  shopping: number,
  /**
   * Whether a written page can follow. The request travels through the site's
   * callback log, so a household with no served site is never promised one.
   */
  canWrite = Boolean(acct.site?.url),
): string {
  const lead = MEAL_WORD[d.meal];
  if (!pick) {
    return `${lead} I have got nothing honest to suggest. Nothing on the shelves adds up to a ${d.meal} right now${shopping ? `, and there are ${shopping} things on the shopping list.` : "."}`;
  }
  const r = pick.recipe;
  const time = r.minutes ? `${r.minutes} minutes` : null;
  const bits: string[] = [`${lead}: ${r.name.toLowerCase()}.`];

  if (pick.ready) {
    bits.push(`Everything it needs is in the house${time ? `, ${time}` : ""}.`);
  } else if (pick.missing.length <= 3) {
    bits.push(`You are short ${list(pick.missing)}. Everything else is here.`);
  } else {
    bits.push(`It needs ${pick.missing.length} things you do not have, so it is a shop first.`);
  }

  if (pick.lastMade) bits.push(`Last made ${pick.lastMade}.`);
  if (url) bits.push(`Recipe: ${url}`);
  else if (!pick.written && canWrite) {
    bits.push(`Writing it out now, the page will follow in a minute.`);
  }
  return bits.join(" ");
}

const list = (xs: string[]) =>
  xs.length === 1 ? xs[0]! : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** The deep link to a written recipe, or null when the household has no served site. */
export function recipeUrl(acct: Account, recipeId: string): string | null {
  const base = acct.site?.url;
  if (!base) return null;
  const [path, query] = base.split("?", 2);
  const dir = path!.replace(/\/[^/]*$/, "");
  return `${dir}/recipe/${encodeURIComponent(recipeId)}.html${query ? `?${query}` : ""}`;
}

/* ── sending ─────────────────────────────────────────────────────────────── */

const IMSG = "/opt/homebrew/bin/imsg";

/**
 * Send one text outside any model session, through `imsg` rather than the IMCore
 * bridge (which double-emits). Throws on failure so the schedule stays unfired
 * and the next pass retries.
 */
export function sendTo(principal: string, body: string): void {
  const handle = principal.replace(/^imessage:dm:/, "");
  if (!handle || handle.startsWith("imessage:")) {
    throw new Error(`cannot text ${principal}: not a direct handle`);
  }
  execFileSync(IMSG, ["send", "--to", handle, "--text", body, "--service", "imessage"], {
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Queue the same request a "Make this" tap produces, so there is one path from
 * wanting a recipe to a written page. Best-effort; false with no served site.
 */
export function requestWrite(
  acct: Account,
  pick: Pick,
  to: Array<{ principal: string }>,
  now = new Date(),
): boolean {
  const dir = acct.site?.artifact;
  if (!dir || !existsSync(dir)) return false;
  const line = JSON.stringify({
    kind: "make",
    recipe: pick.recipe.id,
    name: pick.recipe.name,
    users: to.map((t) => t.principal),
    missing: pick.missing,
    note: "scheduled",
    profile: null,
    ts: now.toISOString(),
    client_ts: now.toISOString(),
  });
  appendFileSync(join(dir, "_callbacks.jsonl"), `${line}\n`);
  return true;
}

export type FireResult = {
  id: string;
  picked: string | null;
  sent: string[];
  failed: Array<{ principal: string; why: string }>;
  queuedWrite: boolean;
};

/**
 * Fire one schedule: pick, text whoever is still owed, and ask for a page if the
 * dish is not written. Marked fired for the day only once everybody has it;
 * each success is recorded so a retry reaches only those still owed.
 */
export function fire(account: string, d: Dinner, now = new Date()): FireResult {
  const acct = getAccount(account);
  if (!acct) throw new Error(`no such household: ${account}`);
  const to = owed(d, acct, now);
  const res: FireResult = {
    id: d.id,
    picked: null,
    sent: [],
    failed: [],
    queuedWrite: false,
  };
  // Nobody left to text: everyone has today's, or every recipient has left the
  // household, which is reported.
  if (!to.length) {
    if (!recipients(d, acct).length) {
      res.failed.push({
        principal: "(nobody)",
        why: "no recipient of this schedule lives here any more",
      });
    }
    return res;
  }

  const cutoff = dayKeyOf(new Date(now.getTime() - REPEAT_DAYS * 86_400_000));
  const recent = new Set((d.picks ?? []).filter((p) => p.day >= cutoff).map((p) => p.recipe));
  const pick = pickFor(account, acct, d.meal, now, recent);
  const url = pick?.written ? recipeUrl(acct, pick.recipe.id) : null;
  const shopping = live(account).filter((i) => i.level === "out" || i.level === "low").length;
  const body = composeText(pick, d, acct, url, shopping);
  res.picked = pick?.recipe.name ?? null;

  const receipts = new Set(d.sent ?? []);
  for (const person of to) {
    try {
      sendTo(person.principal, body);
      res.sent.push(person.principal);
      receipts.add(receipt(person.principal, now));
    } catch (e) {
      res.failed.push({ principal: person.principal, why: (e as Error).message });
    }
  }
  // Ask for a page only on the first send, not on retries for a failed recipient.
  if (pick && !pick.written && res.sent.length && !(d.sent ?? []).length) {
    try {
      res.queuedWrite = requestWrite(acct, pick, recipients(d, acct), now);
    } catch {
      // The text landed; a missing page is not worth failing the fire.
    }
  }
  if (res.sent.length) {
    const everyone = recipients(d, acct).every((p) => receipts.has(receipt(p.principal, now)));
    saveDinners(
      account,
      dinnersOf(acct).map((x) =>
        x.id === d.id
          ? {
              ...x,
              sent: [...receipts].filter((s) => s.startsWith(dayKeyOf(now))),
              fired: everyone ? dayKeyOf(now) : (x.fired ?? null),
              last: now.toISOString(),
              picks: pick
                ? [
                    ...(x.picks ?? []).filter((p) => p.day !== dayKeyOf(now)),
                    { day: dayKeyOf(now), recipe: pick.recipe.id },
                  ].slice(-PICKS_KEPT)
                : (x.picks ?? []),
            }
          : x,
      ),
    );
  }
  return res;
}

/** Every schedule across a household that is due this minute. */
export function due(acct: Account, now = new Date()): Dinner[] {
  return dinnersOf(acct).filter((d) => dueNow(d, now));
}

export { DAY_NAME, SHORT_DAY };
