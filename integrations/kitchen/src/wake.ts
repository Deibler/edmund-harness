/**
 * Waking me for the things only I should answer.
 *
 * The drain settles every tap that is arithmetic. What is left is judgement:
 * which ten dinners suit this house this week, what "chicken parm" actually
 * needs from a supermarket, whether milk can stand in for cream on step three.
 * Those used to go to a narrow model on OpenRouter that had never met the
 * household, or sat in the queue behind an alarm that had been dead for weeks.
 * Now they wake me, in a chat I already know these people from, with the
 * exact tool to answer through.
 *
 * WHICH CHAT. The person who tapped, when they are a member with a chat of
 * their own: it is their question and that session already knows them. When
 * nobody in particular asked (the morning pass), the household's `wake`
 * member, else the first one listed. Never a group, because everything I
 * write in a group turn lands on every phone in it.
 *
 * HOW OFTEN. Once per request per twenty minutes, three times at most. A
 * request I have not answered after three wakes is one I have decided not to
 * answer, and a fourth wake would only cost the household another turn. The
 * ledger of attempts lives next to the household's other state, and a corrupt
 * one costs at most three more wakes rather than an unanswered site.
 *
 * WHAT THE WAKE SAYS. One event per chat per pass, listing every request due,
 * each with the tool that writes its answer. The answers go on the site, so
 * the event ends by telling me to say nothing in the chat itself.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CronStore } from "../../../src/cron/store.ts";
import type { JobInput } from "../../../src/cron/types.ts";
import { accountDir, eaters, householdTitle } from "./accounts.ts";
import type { MakeRequest } from "./requests.ts";
import { requestKey } from "./requests.ts";
import { dataDir } from "./settings.ts";
import type { Account } from "./types.ts";

export const MAX_ATTEMPTS = 3;
export const RETRY_MS = 20 * 60_000;
/** Entries older than this are forgotten; the request they name is long gone. */
const FORGET_MS = 7 * 86_400_000;

export type WakeItem = {
  /** Dedup identity. A request key, or `ideas:<day>` for the morning pass. */
  key: string;
  /** Whose question this is, when it is somebody's. */
  requester?: string | null;
  /** What to do, as a line in the event. */
  line: string;
};

export type WakeResult = {
  woke: Array<{ session: string; keys: string[]; job: string }>;
  /** Keys not woken for this pass, with why. */
  held: Array<{ key: string; why: "exhausted" | "recent" | "no session" }>;
};

type Ledger = Record<string, { attempts: number; last: number }>;

function ledgerPath(account: string): string {
  return join(accountDir(), account, "wakes.json");
}

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

/** The chat a question wakes me in. Null only for a household with no members. */
export function sessionFor(acct: Account, requester?: string | null): string | null {
  const people = eaters(acct).map((e) => e.principal);
  if (requester && people.includes(requester)) return requester;
  if (acct.wake && people.includes(acct.wake)) return acct.wake;
  return people[0] ?? null;
}

/** What to call the person who tapped, for the event. */
export function nameOf(acct: Account, principal?: string | null): string {
  if (!principal) return "Somebody";
  return eaters(acct).find((e) => e.principal === principal)?.label ?? "Somebody";
}

/** Text that survives being pasted into an event. */
const q = (s: string | undefined | null, n = 160) => JSON.stringify((s ?? "").slice(0, n));

/**
 * One request as a line of the event, with the tool that answers it.
 *
 * Every kind that can wake me is named here, and the fallback is a pointer at
 * `kitchen_requests`, which prints the full body. Detail goes in the line only
 * when it saves a lookup: the question somebody asked out loud, the items they
 * picked, the theme they typed.
 */
export function describeRequest(acct: Account, r: MakeRequest): string {
  const who = nameOf(acct, r.profile);
  const dish = r.name ?? r.recipe ?? "";
  const key = requestKey(r);
  switch (r.kind) {
    case "voice":
      return `${who} asked out loud from ${r.recipe ? `step ${r.step ?? "?"} of ${q(dish)}` : "the site"}: ${q(r.text)}\n   kitchen_voice profile:${q(r.profile)} rid:${q(r.rid)} say:"<the answer, under 70 words, spoken English, built on what kitchen_status says is actually in the house>"`;
    case "addlist": {
      const picked = [...(r.items ?? []), ...(r.missing ?? [])].filter(Boolean);
      return `${who} wants what ${q(dish)} needs on the shopping list; picked: ${picked.join(", ") || "(nothing named)"}\n   kitchen_status first, then kitchen_shopping add:[{name, amount, cat}] key:${q(key)} — real supermarket products, nothing the house already owns, staples assumed unless status says otherwise`;
    }
    case "explore":
      return (
        `${who} asked for dishes unlike anything this house cooks${r.text?.trim() ? `, theme: ${q(r.text.trim())}` : ""}\n` +
        `   kitchen_explore action:"brief"${r.text?.trim() ? ` theme:${q(r.text.trim())}` : ""}, write eight, then kitchen_explore action:"save" key:${q(key)}`
      );
    case "idearecipe":
      return (
        `${who} wants the explore idea ${q(dish)} written out as a real recipe page\n` +
        `   kitchen_recipe_save (its shopping is the buy list on the explore page), text them the page, then kitchen_requests handled:[${q(key)}]`
      );
    case "chat":
      return (
        `${who} asked on the site (${r.page ?? "?"}${r.subject ? `, looking at ${q(r.subject)}` : ""}): ${q(r.text)}\n` +
        `   kitchen_chat profile:${q(r.profile)} reply:"<the answer>" then kitchen_requests handled:[${q(key)}]`
      );
    case "make":
      return (
        `${who} pressed Make on ${q(dish)}, which has never been written out\n` +
        `   kitchen_plan, kitchen_recipe_save, text the page to whoever kitchen_requests lists, then kitchen_requests handled:[${q(key)}]`
      );
    case "variant":
      return (
        `${who} wants ${q(dish)} built around what the house actually has${r.missing?.length ? ` (missing: ${r.missing.join(", ")})` : ""}\n` +
        `   kitchen_recipe_save with base:${q(r.recipe)}, text the page, then kitchen_requests handled:[${q(key)}]`
      );
    case "compose":
      return (
        `${who} says nothing in the catalog is tonight's dinner${r.text?.trim() ? `; steer: ${q(r.text.trim())}` : ""}\n` +
        `   kitchen_status for what is on a clock, write a dish around it, kitchen_plan, kitchen_recipe_save, text the page, then kitchen_requests handled:[${q(key)}]`
      );
    default:
      return `${who}: ${r.kind}${dish ? ` ${q(dish)}` : ""}\n   kitchen_requests has the body; kitchen_requests handled:[${q(key)}] once served`;
  }
}

/** The event text, for one chat. */
export function eventText(acct: Account, items: WakeItem[]): string {
  const n = items.length;
  return [
    `[Kitchen · ${householdTitle(acct)}] ${n === 1 ? "One thing" : `${n} things`} on the household site ${n === 1 ? "needs" : "need"} you, and this is yours to do, not a sub-agent's. The answers go on the site through the kitchen tools, not into this chat. Anything about food starts with kitchen_status.`,
    "",
    ...items.map((it, i) => `${i + 1}. ${it.line}`),
    "",
    "When it is done, reply with exactly KEEP_QUIET.",
  ].join("\n");
}

/**
 * Wake me for whatever is due, one event per chat.
 *
 * `create` is the cron insert, injectable so the policy can be tested without
 * a database and so a test can hand in a store of its own. The default opens
 * the harness cron store lazily: a pass with nothing due never touches it.
 */
export function wake(
  account: string,
  acct: Account,
  items: WakeItem[],
  opts: { create?: (input: JobInput) => { id: string }; now?: number } = {},
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
    const seen = ledger[it.key];
    if (seen && seen.attempts >= MAX_ATTEMPTS) {
      out.held.push({ key: it.key, why: "exhausted" });
      continue;
    }
    if (seen && now - seen.last < RETRY_MS) {
      out.held.push({ key: it.key, why: "recent" });
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
  for (const [session, due] of bySession) {
    const job = create({
      sessionKey: session,
      systemEvent: eventText(acct, due),
      schedule: { kind: "once", atMs: now },
    });
    for (const it of due) {
      const seen = ledger[it.key];
      ledger[it.key] = { attempts: (seen?.attempts ?? 0) + 1, last: now };
    }
    out.woke.push({ session, keys: due.map((d) => d.key), job: job.id });
  }
  writeLedger(account, ledger);
  return out;
}

/**
 * The real thing: a one-shot row in the daemon's cron store, polled within
 * seconds. Built here, not at import, so a pass with nothing due never opens
 * the database.
 */
function defaultCreate(): (input: JobInput) => { id: string } {
  const store = new CronStore(dataDir());
  return (input) => store.create(input);
}

/** Wake me for the requests a pass left for a person. */
export function wakeForRequests(
  account: string,
  acct: Account,
  reqs: MakeRequest[],
  opts: Parameters<typeof wake>[3] = {},
): WakeResult {
  return wake(
    account,
    acct,
    reqs.map((r) => ({
      key: requestKey(r),
      requester: r.profile ?? null,
      line: describeRequest(acct, r),
    })),
    opts,
  );
}

/** Wake me to write the morning's ideas. Keyed by day, so one wake per morning. */
export function wakeForIdeas(
  account: string,
  acct: Account,
  want: number,
  opts: Parameters<typeof wake>[3] = {},
): WakeResult {
  const day = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
  return wake(
    account,
    acct,
    [
      {
        key: `ideas:${day}`,
        line: `The morning pass wants ${want} new dinner or lunch idea${want === 1 ? "" : "s"} for this house, built strictly from what is on the shelves.\n   kitchen_ideas action:"brief" gives the exact ingredient slugs, what expires soonest and the names to stay away from. Write them for these people, then kitchen_ideas action:"save".`,
      },
    ],
    opts,
  );
}
