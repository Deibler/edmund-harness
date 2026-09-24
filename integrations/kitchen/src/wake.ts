/**
 * Bringing kitchen work to the household's main Edmund session.
 *
 * Nothing in the kitchen thinks on its own. Work that needs judgement (writing
 * a recipe, answering a question asked at the stove, reviewing the inventory,
 * following up on a meal) is queued as a one-shot event in the main session of
 * the person it concerns, which already carries their tastes and history. The
 * event names the exact tools that write the answer.
 *
 * Which session:
 *   - a site tap goes to the member who tapped;
 *   - a follow-up goes to whoever the meal was planned for;
 *   - unattended work (the morning review) goes to the household's `wake`
 *     member, else the first member listed. Never a group.
 *
 * Whether it talks:
 *   - Make and similar requests are conversations: the reply is a text to the
 *     person, who may be asked a short question before the recipe is written.
 *   - A follow-up is a text by definition.
 *   - Site answers (chat, voice, explore) and the morning review are silent:
 *     the answer lands on the site or in the ledger, and the turn ends quietly.
 *
 * Retries: once per item per twenty minutes, three times at most, tracked in
 * the household's `wakes.json`. A person asking again (`fresh`) starts a new
 * round of attempts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CronStore } from "../../../src/cron/store.ts";
import type { JobInput } from "../../../src/cron/types.ts";
import { accountDir, eaters, householdTitle } from "./accounts.ts";
import { type Evidence, describeEvidence } from "./evidence.ts";
import type { Due } from "./followups.ts";
import {
  type NoteBrief,
  SENTINEL,
  THEIRS_ABOVE,
  noteText,
  noteTitle,
  ownLinesText,
  showNote,
} from "./notelist.ts";
import type { MakeRequest } from "./requests.ts";
import { requestKey } from "./requests.ts";
import { dataDir } from "./settings.ts";
import type { Account } from "./types.ts";

export const MAX_ATTEMPTS = 3;
export const RETRY_MS = 20 * 60_000;
/** Entries older than this are forgotten; the request they name is long gone. */
const FORGET_MS = 7 * 86_400_000;

export const QUIET = "When it is done, reply with exactly KEEP_QUIET.";

export type WakeItem = {
  /** Dedup identity: a request key, `review:<day>` or `followup:<plan>`. */
  key: string;
  /** Whose question this is, when it is somebody's. */
  requester?: string | null;
  /** What to do, as a numbered line in the event. */
  line: string;
  /** True when the answer is a text to the person rather than a silent write. */
  talk?: boolean;
};

export type WakeResult = {
  woke: Array<{ session: string; keys: string[]; job: string }>;
  /** Keys not woken for this pass, with why. */
  held: Array<{ key: string; why: "exhausted" | "recent" | "no session" }>;
};

type Ledger = Record<string, { attempts: number; last: number }>;
type Hold = "exhausted" | "recent";

/**
 * Why an item with this ledger entry is not woken now, or null when it is.
 * `fresh` is a person asking again: their ask gets its own attempts, though
 * never a second turn within RETRY_MS of the last.
 */
function holdFor(seen: Ledger[string] | undefined, now: number, fresh = false): Hold | null {
  if (!seen || now - seen.last > FORGET_MS) return null;
  if (!fresh && seen.attempts >= MAX_ATTEMPTS) return "exhausted";
  if (now - seen.last < RETRY_MS) return "recent";
  return null;
}

/**
 * Whether `wake` would hold this key right now, without waking anything. For
 * a caller that must do something costly (look at the screen) only when a
 * wake would really go out.
 */
export function wakeHeld(
  account: string,
  key: string,
  now = Date.now(),
  fresh = false,
): Hold | null {
  return holdFor(readLedger(account)[key], now, fresh);
}

const ledgerPath = (account: string) => join(accountDir(), account, "wakes.json");

function readLedger(account: string): Ledger {
  const p = ledgerPath(account);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Ledger;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeLedger(account: string, l: Ledger): void {
  const p = ledgerPath(account);
  mkdirSync(join(accountDir(), account), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(l, null, 2));
  renameSync(tmp, p);
}

/** The session a piece of work goes to. Null only for a household with no members. */
export function sessionFor(acct: Account, requester?: string | null): string | null {
  const people = eaters(acct).map((e) => e.principal);
  if (requester && people.includes(requester)) return requester;
  if (acct.wake && people.includes(acct.wake)) return acct.wake;
  return people[0] ?? null;
}

/** What to call a member in an event. */
export function nameOf(acct: Account, principal?: string | null): string {
  if (!principal) return "Somebody";
  return eaters(acct).find((e) => e.principal === principal)?.label ?? "Somebody";
}

/** Text that survives being pasted into an event. */
const q = (s: string | undefined | null, n = 160) => JSON.stringify((s ?? "").slice(0, n));

/** Request kinds whose answer is a conversation with the person who tapped. */
const TALKS = new Set(["make", "variant", "compose", "idearecipe"]);

/**
 * How to write a dish somebody asked for from the site: in conversation, asking
 * only what the ledger cannot answer.
 */
const WRITE_IN_CHAT =
  "Text them in this chat. Check the ingredients with kitchen_status first. If the dish " +
  'depends on something the kitchen is unsure of, ask them one short line first ("Do you ' +
  'still have the mushrooms?") and write it once they answer; otherwise write it now';

/**
 * One request as a line of the event, with the tool that answers it.
 *
 * Every kind that can wake is named here; anything else points at
 * `kitchen_requests`, which prints the full body.
 */
export function describeRequest(acct: Account, r: MakeRequest): string {
  const who = nameOf(acct, r.profile);
  const dish = r.name ?? r.recipe ?? "";
  const key = requestKey(r);
  const done = `kitchen_requests handled:[${q(key)}]`;
  switch (r.kind) {
    case "voice":
      return `${who} asked out loud from ${r.recipe ? `step ${r.step ?? "?"} of ${q(dish)}` : "the site"}: ${q(r.text)}\n   kitchen_voice profile:${q(r.profile)} rid:${q(r.rid)} say:"<the answer, under 70 words, spoken English, built on what kitchen_status says is actually in the house>"`;
    case "addlist": {
      const picked = [...(r.items ?? []), ...(r.missing ?? [])].filter(Boolean);
      return `${who} wants what ${q(dish)} needs on the shopping list; picked: ${picked.join(", ") || "(nothing named)"}\n   kitchen_status first, then kitchen_shopping add:[{name, amount, cat}] key:${q(key)}: real supermarket products, nothing the house already owns, basics assumed unless status says otherwise`;
    }
    case "explore":
      return (
        `${who} asked for dishes unlike anything this house cooks${r.text?.trim() ? `, theme: ${q(r.text.trim())}` : ""}\n` +
        `   kitchen_explore action:"brief"${r.text?.trim() ? ` theme:${q(r.text.trim())}` : ""}, write eight, then kitchen_explore action:"save" key:${q(key)}`
      );
    case "chat":
      return (
        `${who} asked on the site (${r.page ?? "?"}${r.subject ? `, looking at ${q(r.subject)}` : ""}): ${q(r.text)}\n` +
        `   kitchen_chat profile:${q(r.profile)} reply:"<the answer>" then ${done}`
      );
    case "make":
      if (r.note === "scheduled") {
        // The dinner text already went out; the page follows it quietly.
        return (
          `The dinner text suggested ${q(dish)}, which has never been written out.\n` +
          `   kitchen_plan, kitchen_recipe_save, then text the page link in one line to the people kitchen_requests lists for it. Then ${done}.`
        );
      }
      return (
        `${who} pressed Make on ${q(dish)}, which has never been written out.\n` +
        `   ${WRITE_IN_CHAT}: kitchen_plan, kitchen_recipe_save, then send the page with one line. Then ${done}.`
      );
    case "variant":
      return (
        `${who} wants ${q(dish)} built around what the house actually has${r.missing?.length ? ` (missing: ${r.missing.join(", ")})` : ""}.\n` +
        `   ${WRITE_IN_CHAT}: kitchen_recipe_save with base:${q(r.recipe)}, then send the page. Then ${done}.`
      );
    case "compose":
      return (
        `${who} says nothing in the catalog is tonight's dinner${r.text?.trim() ? `; steer: ${q(r.text.trim())}` : ""}.\n` +
        `   ${WRITE_IN_CHAT}: a real dinner around what is on a clock, kitchen_plan, kitchen_recipe_save, then send the page. Then ${done}.`
      );
    case "idearecipe":
      return (
        `${who} wants the explore idea ${q(dish)} written out as a real recipe page.\n` +
        `   ${WRITE_IN_CHAT}: kitchen_recipe_save (its shopping is the buy list on the explore page), then send the page. Then ${done}.`
      );
    default:
      return `${who}: ${r.kind}${dish ? ` ${q(dish)}` : ""}\n   kitchen_requests has the body; ${done} once served`;
  }
}

/** The event for one session. */
export function eventText(acct: Account, items: WakeItem[], session?: string | null): string {
  const n = items.length;
  const talking = items.filter((it) => it.talk);
  const who = nameOf(acct, session);
  const closing = talking.length
    ? talking.length === n
      ? `Your reply goes to ${who} as a text, so keep it short and friendly.`
      : `Answer the site items through the tools first. Your reply goes to ${who} as a text about the rest, so keep it short and friendly.`
    : QUIET;
  return [
    `[Kitchen · ${householdTitle(acct)}] ${n === 1 ? "One thing" : `${n} things`} from the household site. Anything about food starts with kitchen_status.`,
    "",
    ...items.map((it, i) => `${i + 1}. ${it.line}`),
    "",
    closing,
  ].join("\n");
}

/**
 * Queue one event per session for whatever is due.
 *
 * `create` is the cron insert, injectable so the policy can be tested without
 * a database. The default opens the harness cron store lazily.
 */
export function wake(
  account: string,
  acct: Account,
  items: WakeItem[],
  opts: {
    create?: (input: JobInput) => { id: string };
    now?: number;
    /** Build the event for a session; defaults to `eventText`. */
    text?: (items: WakeItem[], session: string) => string;
    /** Somebody asked again: a new round of attempts (see `holdFor`). */
    fresh?: boolean;
  } = {},
): WakeResult {
  const out: WakeResult = { woke: [], held: [] };
  if (!items.length) return out;
  const now = opts.now ?? Date.now();
  const ledger = readLedger(account);
  for (const [k, v] of Object.entries(ledger)) {
    if (now - v.last > FORGET_MS) delete ledger[k];
  }

  const bySession = new Map<string, WakeItem[]>();
  for (const it of items) {
    const hold = holdFor(ledger[it.key], now, opts.fresh);
    if (hold) {
      out.held.push({ key: it.key, why: hold });
      continue;
    }
    const session = sessionFor(acct, it.requester);
    if (!session) {
      out.held.push({ key: it.key, why: "no session" });
      continue;
    }
    bySession.set(session, [...(bySession.get(session) ?? []), it]);
  }
  if (!bySession.size) return out;

  const create = opts.create ?? defaultCreate();
  const render = opts.text ?? ((due, session) => eventText(acct, due, session));
  for (const [session, due] of bySession) {
    const job = create({
      sessionKey: session,
      systemEvent: render(due, session),
      schedule: { kind: "once", atMs: now },
      harnessWritten: true,
    });
    for (const it of due) {
      const before = opts.fresh ? 0 : (ledger[it.key]?.attempts ?? 0);
      ledger[it.key] = { attempts: before + 1, last: now };
    }
    out.woke.push({ session, keys: due.map((d) => d.key), job: job.id });
  }
  writeLedger(account, ledger);
  return out;
}

function defaultCreate(): (input: JobInput) => { id: string } {
  const store = new CronStore(dataDir());
  return (input) => store.create(input);
}

export type WakeOpts = NonNullable<Parameters<typeof wake>[3]>;

/** Wake the right session for each site request a person has to answer. */
export function wakeForRequests(
  account: string,
  acct: Account,
  reqs: MakeRequest[],
  opts: WakeOpts = {},
): WakeResult {
  return wake(
    account,
    acct,
    reqs.map((r) => ({
      key: requestKey(r),
      requester: r.profile ?? null,
      line: describeRequest(acct, r),
      talk: TALKS.has(r.kind) && r.note !== "scheduled",
    })),
    opts,
  );
}

/* ------------------------------------------------------------------ *
 * The morning review
 * ------------------------------------------------------------------ */

/** The most items one review asks about. More than this and none get real thought. */
export const REVIEW_MAX = 15;

export function reviewText(acct: Account, items: Evidence[]): string {
  return [
    `[Kitchen · ${householdTitle(acct)}] Morning inventory review. Nobody asked for this and nobody sees it.`,
    "",
    "The ledger only hears about groceries, so it drifts from the real kitchen. Reason about",
    "each item below the way a person would: when it was bought, what you have cooked or",
    "suggested with it since, how long it keeps where it is stored, and anything you know",
    "from this chat about how they eat. Decide one verdict per item:",
    "  here   still in the house as far as you can tell (thin evidence means here)",
    "  frozen raw meat or fish past fridge life that was most likely frozen",
    "  low    probably running low",
    "  gone   probably used up, eaten or thrown out",
    "",
    ...items.map((e, i) => `${i + 1}. ${describeEvidence(e)}`),
    "",
    'Then kitchen_inventory action:"assess" verdicts:[{item, verdict, reason}], with the reason',
    "in a few plain words. Nothing is removed yet: low and gone are raised in the next",
    '"did you make it?" follow-up and assumed only if nobody answers.',
    "",
    QUIET,
  ].join("\n");
}

/** Wake the household's session to review what the kitchen is unsure of. Once per day. */
export function wakeForReview(
  account: string,
  acct: Account,
  items: Evidence[],
  opts: WakeOpts = {},
): WakeResult {
  if (!items.length) return { woke: [], held: [] };
  const day = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
  const shown = items.slice(0, REVIEW_MAX);
  return wake(account, acct, [{ key: `review:${day}`, line: "" }], {
    ...opts,
    text: () => reviewText(acct, shown),
  });
}

/* ------------------------------------------------------------------ *
 * The follow-up after a meal
 * ------------------------------------------------------------------ */

export function followupText(acct: Account, due: Due, offers: string[], session: string): string {
  const { plan, suspects } = due;
  const who = nameOf(acct, session);
  const raise = suspects.map((s) => `  - ${s.name} [${s.id}]: ${s.reason} (${s.verdict})`);
  return [
    `[Kitchen · ${householdTitle(acct)}] Follow up with ${who} about ${q(plan.meal)} (plan ${plan.id}), sent ${plan.created.slice(0, 10)}.`,
    "",
    "Send one short text they can answer in a word or two, shaped like:",
    `  "Did you end up making the ${plan.meal.toLowerCase()}? Also, I think you might be low on X and Y. Want me to add them to the list, or anything else?"`,
    "",
    raise.length ? "Things you suspect (leave out any you now know are fine):" : "",
    ...raise,
    offers.length ? `Ran out of, and they cook with (offer to add): ${offers.join(", ")}` : "",
    "",
    "No paragraphs, no explaining how you know, nothing that needs a long answer. When they reply:",
    `  - made it or not: kitchen_plan_resolve plan:"${plan.id}" made:true|false`,
    "  - yes, add it: kitchen_shopping add:[...]",
    '  - still have it, or it is gone: kitchen_inventory action:"assess" told:true verdicts:[...]',
    "Anything they do not mention is assumed in two days.",
    "",
    `Your reply goes to ${who} as a text.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Wake the person a meal was planned for, to ask whether they made it. */
export function wakeForFollowup(
  account: string,
  acct: Account,
  due: Due,
  offers: string[],
  opts: WakeOpts = {},
): WakeResult {
  return wake(
    account,
    acct,
    [{ key: `followup:${due.plan.id}`, requester: due.plan.by ?? null, line: "", talk: true }],
    { ...opts, text: (_, session) => followupText(acct, due, offers, session) },
  );
}

/* ------------------------------------------------------------------ *
 * The shared note
 * ------------------------------------------------------------------ */

/**
 * The wake for a note that is behind. Edmund's own lines that left the list
 * come first, before the list, so the screen check (which reads the first
 * 4,000 characters of the event) always sees which deletions were asked for.
 */
export function noteEventText(account: string, acct: Account, brief: NoteBrief): string {
  const title = noteTitle(account);
  return [
    `[Kitchen · ${householdTitle(acct)}] The shopping list changed, so the shared Apple Note "${title}" is behind. Bring it up to date on screen with the computer tools. Nobody asked for this in chat.`,
    "",
    ownLinesText(brief.gone),
    "",
    `Above the line "${SENTINEL}" the note should read, in this order (version ${brief.version}):`,
    "",
    noteText(brief.lines),
    "",
    `1. request_access for Notes, open_application Notes, and open "${title}" from the note list. Touch no other note.`,
    "2. Screenshot and read it. Below the sentinel line is the household's own: anything new there is an item somebody wants. Put it on the list with kitchen_shopping add (by: whoever wrote it, when you can tell), then delete it from below the line.",
    brief.gone === null
      ? "3. Above the sentinel, leave every line that is not in the list where it is."
      : `3. ${THEIRS_ABOVE}`,
    "   If you added anything, work from the lines and version in that kitchen_shopping reply instead.",
    "4. Change only the lines that differ: delete only lines named above as yours, add new ones as unticked checklist lines (Format > Checklist), and leave every tick where it is. Never select all and paste; a whole-note paste lets a phone bring old lines back as copies.",
    `5. Screenshot to check, then kitchen_shopping noteWritten:true noteVersion:"${brief.version}".`,
    "If this chat has no computer tools, or Notes will not cooperate, stop without calling noteWritten.",
    "",
    QUIET,
  ].join("\n");
}

/** The note's wake key: one per list version. */
export const noteKey = (signature: string) => `note:${signature}`;

/**
 * Wake the household's session to bring its note up to date with the list.
 * Keyed on the list's signature, so one list state wakes at most
 * MAX_ATTEMPTS times; a newer list is a new key, and a person asking from
 * the site (`fresh`) is a new round. What Edmund is shown is recorded as he
 * is shown it, so his confirmation can name it.
 */
export function wakeForNote(
  account: string,
  acct: Account,
  signature: string,
  opts: WakeOpts = {},
): WakeResult {
  return wake(account, acct, [{ key: noteKey(signature), line: "" }], {
    ...opts,
    text: () => noteEventText(account, acct, showNote(account, opts.now)),
  });
}
