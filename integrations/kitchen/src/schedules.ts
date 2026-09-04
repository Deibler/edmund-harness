/**
 * Standing dinner texts.
 *
 * "Text me at four every day and tell me what we are having." The whole feature
 * is that sentence, and the design follows from one property of it: the text has
 * to ARRIVE. A suggestion that lands at 4:00 four days out of five is worse than
 * no suggestion at all, because the household stops planning around it and then
 * stops reading it.
 *
 * So the pick is deterministic. It is the same ranking the home page already
 * runs — what the shelves can actually cook, reordered by what the day argues
 * for — and it needs nothing but the ledger and a clock. The launchd pass that
 * drains the site's buttons fires these too, and sends the text
 * itself. No model is in the delivery path.
 *
 * A model is still wanted for the part it is good at. If the dish has never been
 * written out, firing also drops the exact request a person would have made by
 * pressing "Make this" into the site's callback queue, which wakes a session,
 * which writes the page and sends it. That is an enrichment on top of a text
 * that already went out, rather than a dependency the text waits on.
 *
 * Two rules that are less obvious than they look:
 *
 *   A missed window is skipped, never fired late. If the Mac was asleep at four
 *   and wakes at nine, a text about tonight's dinner is now a text about a
 *   dinner that did not happen. Silence is the honest output.
 *
 *   Firing opens no plan and consumes nothing. Being told what to cook is not
 *   evidence that anybody cooked it, and this integration's whole posture is
 *   that only a human saying so takes food off a shelf.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eaters, getAccount, updateAccount } from "./accounts.ts";
import { loadCookbook } from "./cookbook.ts";
import { fitScore } from "./fit.ts";
import { lastMade, madeIndex } from "./made.ts";
import { moodFor, moodScore, readWeather } from "./mood.ts";
import { loadProfiles } from "./profile.ts";
import { type Cookable, type Recipe, cookable, loadRecipes } from "./recipes.ts";
import { fold, live } from "./store.ts";
import type { Account } from "./types.ts";

/** Which meal a standing text is about. */
export const MEALS = ["dinner", "lunch", "breakfast"] as const;
export type MealKind = (typeof MEALS)[number];

/**
 * Categories each meal is willing to propose. A schedule says which meal it is.
 *
 * `dinner` deliberately does NOT reuse MEAL_CATS. That set answers "is this a
 * meal rather than a side or a dessert", which is a different question, and the
 * two differ on exactly one category: a dish somebody authored as lunch is
 * lunch. Sharing one set is how a fifteen-minute ham and Swiss sandwich, fully
 * in stock and never yet cooked, beat every real dinner in the house on the 4pm
 * text.
 *
 * The asymmetry with `lunch` is intended. A dinner dish genuinely can be lunch,
 * which is what leftovers are, but a sandwich is not dinner. The relation only
 * runs one way, so it cannot be one shared set however tempting that looks.
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
   * Who has already received today's, as `YYYY-MM-DD|principal`.
   *
   * Per person because sends fail per person. `fired` alone meant one transient
   * failure — a wedged `imsg`, which happens — silently cost that person the
   * whole day while the household read as delivered. With this the next pass
   * inside the grace window retries only the people it owes, and nobody gets
   * a second copy of a text they already have.
   */
  sent?: string[];
  /** ISO of the last send, for "last sent" on the page. */
  last?: string | null;
};

/**
 * How late a fire may be and still be worth sending.
 *
 * Long enough to survive a laptop lid, short enough that the text is still about
 * the evening it was written for.
 */
export const GRACE_MIN = 75;

const DAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function dinnersOf(acct: Account): Dinner[] {
  return (acct.dinners ?? []).slice().sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Coerce anything into a schedule that cannot misbehave, or refuse it.
 *
 * Every write path goes through here — the site's sheet, the MCP tool, a hand
 * edit of the registry — because an invariant enforced on one path is not
 * enforced. The specific thing being prevented is a `to` list naming somebody
 * who does not live here, which would text a stranger a dinner every night.
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
    // Only today's receipts are worth keeping; yesterday's cannot suppress
    // anything and would otherwise grow in the registry forever.
    sent: (raw.sent ?? []).filter((s) => typeof s === "string" && s.startsWith(dayKeyOf(now))),
    last: raw.last ?? null,
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
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

/** 24-hour storage, 12-hour display. Nobody says "sixteen hundred" about dinner. */
export function clock(at: string): string {
  const [h, m] = at.split(":").map(Number) as [number, number];
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

const dayKeyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Should this fire right now?
 *
 * Three ways to answer no, and they are different: not today, not yet, and too
 * late to matter. Only the third is a judgement call, and it is the one that
 * keeps a sleeping machine from texting last night's dinner over breakfast.
 */
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

/**
 * Who this schedule still owes a text today.
 *
 * Separate from `dueNow` because they answer different questions: whether the
 * window is open, and who inside it has not been reached yet.
 */
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
 * Tonight's answer, from the ledger alone.
 *
 * Deliberately the same ranking the home page shows, so the text and the page
 * agree. Cookability outranks everything, then how well the dish fits the day,
 * and a dish cooked in the last three weeks is pushed down rather than removed:
 * a household with six recipes and a busy month should still be told something.
 */
export function pickFor(
  account: string,
  acct: Account,
  meal: MealKind = "dinner",
  now = new Date(),
): Pick | null {
  const items = fold(account);
  const { recipes } = loadRecipes(account);
  const book = loadCookbook(account);
  const written = new Set(book.map((b) => b.id));

  // Written-only recipes are cookable choices too. Without this a household
  // whose catalog is thin but whose cookbook is full would be told there is
  // nothing to eat while five written dinners sat one tap away.
  const extra: Recipe[] = book
    .filter((b) => !recipes.some((r) => r.id === b.id))
    .map((b) => ({
      id: b.id,
      name: b.name,
      desc: b.desc,
      minutes: b.minutes,
      needs: b.needs,
      cat: b.cat,
    }));

  const cats = CATS_FOR[meal];
  const all = [...recipes, ...extra].filter((r) => cats.has(r.cat));
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
          // A dish written FOR this meal outranks one merely allowed into the
          // pool. This is a tiebreak, not the guarantee — `CATS_FOR` is the
          // guarantee — but without it a never-cooked wrong-meal dish wins on
          // `novelty` alone, which is the shape of the sandwich bug one layer up.
          (c.recipe.cat === meal ? 45 : 0) +
          // One missing item is a stop at the shop; four is a different dinner.
          -12 * c.missing.length +
          moodScore(c.recipe, mood, acct) +
          // The fridge and the history, on the same terms the home page uses.
          // Deliberately the SAME function: a 4pm text that names one dinner and
          // a site that leads with a different one is worse than either alone,
          // and that is what two hand-written scoring rules drift into. It also
          // subsumes the old repeat penalty, which is why that line is gone.
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

/**
 * What the text actually says.
 *
 * Written here rather than by a model so that it is identical whether a session
 * is awake or not, and so that it can never claim the house has something it
 * does not. Prose, no bullets: it is a text message.
 */
export function composeText(
  pick: Pick | null,
  d: Dinner,
  acct: Account,
  url: string | null,
  shopping: number,
  /**
   * Whether a written page can actually follow this text.
   *
   * Not a detail. The enrichment reaches a session by landing in the site's
   * callback log, which nothing polls unless the site is served, so a household
   * with no public URL would be promised a page that could never arrive. A
   * promise this system cannot keep is worse than saying nothing.
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

/**
 * The deep link to a written recipe, if there is a served site to link into.
 *
 * Returns null rather than a guess when the household has no URL. A link that
 * 404s in a text message is worse than no link, and this is exactly the state
 * a household sits in before anybody has shared its page.
 */
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
 * Send one text, outside any model session.
 *
 * The legacy AppleScript path on purpose: the IMCore bridge double-emits, which
 * on a standing schedule would mean two identical dinner texts every single
 * evening. Throws on failure so the caller can leave the schedule unfired and
 * try again on the next minute's pass rather than silently swallowing the day.
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
 * Ask a session to write this dish out properly.
 *
 * Appends the same request a person's "Make this" tap produces, to the same
 * file, so there is exactly one path from "somebody wants a recipe" to a written
 * page. Best-effort: the text has already gone out, and a household with no
 * served site simply never gets the enrichment.
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
 * Fire one schedule: pick, text whoever is still owed, and ask for a page if
 * there isn't one.
 *
 * Marked fired for the DAY only once everybody has it. Marking on the first
 * success meant a single transient send failure — a wedged `imsg`, which is a
 * thing that happens here — cost that person the day while the log said the
 * schedule had fired. Each success is recorded individually, so the next pass
 * inside the grace window retries exactly the people it owes and nobody gets
 * a duplicate.
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
  // Nobody left to text. Either everyone already has today's, or `to` names
  // people who have since left the household — which is worth saying out loud
  // rather than re-picking a dinner every minute of the window for an audience
  // of nobody.
  if (!to.length) {
    if (!recipients(d, acct).length) {
      res.failed.push({
        principal: "(nobody)",
        why: "no recipient of this schedule lives here any more",
      });
    }
    return res;
  }

  const pick = pickFor(account, acct, d.meal, now);
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
  // Only ask for a page the first time, or a schedule retrying one failed
  // recipient queues a second identical write request every minute.
  if (pick && !pick.written && res.sent.length && !(d.sent ?? []).length) {
    try {
      res.queuedWrite = requestWrite(acct, pick, recipients(d, acct), now);
    } catch {
      // The text landed. A missing enrichment is not worth failing the fire.
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

export { DAY_NAME, SHORT_DAY, dayKeyOf };
