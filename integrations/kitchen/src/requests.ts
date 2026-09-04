/**
 * Taps on the website that need a model to answer them.
 *
 * The site is a static file behind an instant-share token, so it cannot call
 * anything directly. What it can do is POST to the share server's `/callback`
 * endpoint, which appends the JSON body to `_callbacks.jsonl` next to the page.
 * A trigger watches that file and wakes the session; this module is the typed
 * reader for what it finds.
 *
 * The kinds that need real writing rather than a fold:
 *   "make"    — cook this dish; write the long-form recipe if it has never been
 *               written, then text whoever was picked.
 *   "variant" — this dish is missing something; build a version around what the
 *               house actually has, and hang it off the original.
 *   "compose" — none of the cards is the right dinner. Write one for what is
 *               actually on the clock, with no card to start from.
 *
 * That third one is not a nicety. A fixed catalog ranked against stock can only
 * ever return the least-bad card it already holds, so a kitchen holding two
 * proteins a day past date and a catalog of pasta dishes will confidently
 * recommend pasta forever. Composition is the escape hatch, and keeping it a
 * request rather than a background job means it only ever runs because somebody
 * asked for it.
 *
 * Handled requests are recorded by their client timestamp rather than deleted,
 * because the callbacks file is append-only and owned by the share server. A
 * request that has been served must never be served twice: the cost of a
 * duplicate here is a duplicate text message to a real person.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";

/** Everything the page can ask for. Deliberately a closed set. */
export const KINDS = [
  "make", // cook this dish
  "variant", // build a version around what the house has
  "compose", // nothing in the catalog fits: write a dish for what is on the clock
  "chat", // a question asked on the page
  "note", // a note against a meal they made
  "favorite", // star / unstar
  "shopped", // finished a shopping trip, with what was ticked
  "plan", // an in-progress meal was confirmed or called off
  "unsweep", // the automatic cleanup was wrong, put that batch back
  "addlist", // put what this dish needs on the shopping list
  "voice", // a question asked out loud from a recipe page
  "pairskip", // not doing one half of a cook-once-eat-twice pair
  "photo", // a picture of the actual plate, uploaded from a recipe page
  "reconcile", // one verdict from the shelf check, or "apply this pass"
  "cooked", // finished a recipe from its own page; take the ingredients off
  "restock", // the ledger is wrong, this IS in the house
  "pref", // how this house wants to be cooked for: vibe, budget, mode
  "explore", // find dishes unlike anything we cook
  "idealist", // put an explore dish's shopping on the list
  "idearecipe", // write an explore dish out as a real recipe page
  "sched", // create, pause or delete a standing dinner text
  "keep", // whether running out of something means buying it again
  "notes", // push the current list into Apple Notes
] as const;
export type Kind = (typeof KINDS)[number];

export type MakeRequest = {
  kind: Kind;
  /** Catalog or cookbook recipe id. Absent for chat and shopping. */
  recipe?: string;
  /** Display name, carried so a log line is readable without a catalog lookup. */
  name?: string;
  /** Principals the user picked to receive the recipe. Empty means "just me". */
  users?: string[];
  /**
   * Server-stamped time. Authoritative (a browser clock can be wrong) but only
   * second-resolution, which is why it is not the dedup key on its own.
   */
  ts: string;
  /** The browser's own timestamp, kept by the share server as a tiebreaker. */
  client_ts?: string;
  /** For variants: what the house is missing, as the page understood it. */
  missing?: string[];
  note?: string | null;
  /** unsweep: the auto-cleanup batch to retract. */
  batch?: string;
  /** voice: the browser's id for this question, so it can poll for its answer. */
  rid?: string;
  /** voice: which step of which recipe they were looking at. */
  step?: number | null;
  /** photo: path the share server wrote, relative to the artifact root. */
  file?: string;
  /** reconcile: which pass this verdict belongs to, and which shelf slug. */
  session?: string;
  item?: string;
  /** reconcile: the corrected count, when the verdict is "amount". */
  qty?: number | null;
  unit?: string | null;
  /**
   * keep: which shopping line the answer is about.
   *
   * A ledger slug when the line maps to a tracked item, otherwise the written
   * line's own key. Separate from `item` because that one is the shelf-check
   * slug and is validated against live stock; a keep can legitimately name
   * something the kitchen no longer has, which is the usual case.
   */
  id?: string;
  /** Which profile was signed in when this was sent. */
  profile?: string | null;
  /** chat: the question. note: the note body. */
  text?: string;
  /** chat: which panel they were looking at, and the thing on it. */
  page?: string | null;
  subject?: string | null;
  /** favorite: the new state. */
  on?: boolean;
  /** shopped: ledger slugs that were ticked off. */
  items?: string[];
  /** plan: the plan id being confirmed or voided. */
  plan?: string;
  /**
   * pref: a second number, when one field is not enough.
   *
   * The settings sheet writes a weekly budget in `qty` and a per-dinner ceiling
   * here rather than inventing a nested object, because every other request in
   * this file is flat and a callback body that is sometimes nested is a parser
   * with two shapes.
   */
  amount?: number | null;
  /**
   * sched: the standing dinner text being saved or removed.
   *
   * The verb rides in `note` ("save", "pause", "delete"), the recipients in
   * `users`, the weekdays in `days` and the time in `at`. Flat like everything
   * else here — the schedule is validated against the household on arrival, so
   * nothing the browser sends is trusted past the shape of it.
   */
  at?: string;
  days?: number[];
  meal?: string;
};

const isMake = (v: unknown): v is MakeRequest => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.kind === "string" &&
    (KINDS as readonly string[]).includes(o.kind) &&
    typeof o.ts === "string"
  );
};

function handledPath(account: string): string {
  return join(accountDir(), account, "cookbook", "_handled.json");
}

/**
 * The dedup identity of a request.
 *
 * Not the timestamp alone: the share server overwrites whatever the page sent
 * with its own second-resolution clock, so two taps on DIFFERENT dishes inside
 * one second would share a `ts` and the second would be silently swallowed.
 * Including the verb and the dish means the only thing that collides is the
 * same person asking for the same thing twice in a second — which is a
 * double-tap, and swallowing that is the correct behaviour.
 */
export function requestKey(r: Pick<MakeRequest, "ts" | "kind" | "recipe" | "client_ts">): string {
  return `${r.ts}|${r.kind}|${r.recipe ?? ""}|${r.client_ts ?? ""}`;
}

export function handled(account: string): Set<string> {
  const p = handledPath(account);
  if (!existsSync(p)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(p, "utf8")) as string[]);
  } catch {
    // An unreadable ledger of what has been served must fail CLOSED, or the
    // next poll re-texts everyone every dish they have ever asked for.
    throw new Error(`kitchen: cannot read ${p}; refusing to re-serve requests blindly`);
  }
}

/**
 * Record requests as served.
 *
 * Written to a temp file and renamed, because `handled` deliberately fails
 * CLOSED: a file it cannot parse throws, and that throw takes down every pass
 * for the household until a human edits JSON. A direct write leaves exactly
 * that file behind if the process dies mid-write, and this runs on every tap,
 * so it is the most frequently hit window in the integration rather than a
 * theoretical one. Rename is atomic, so a reader sees the old list or the new
 * one and never half of either.
 */
export function markHandled(account: string, keys: string[]): void {
  const p = handledPath(account);
  mkdirSync(join(accountDir(), account, "cookbook"), { recursive: true });
  const all = existsSync(p) ? handled(account) : new Set<string>();
  for (const k of keys) all.add(k);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify([...all], null, 2));
  renameSync(tmp, p);
}

/**
 * Unserved requests sitting in an artifact's callback log, oldest first.
 *
 * Lines that do not parse or are not requests are skipped rather than thrown
 * on: this file is written by a public endpoint, so anything can land in it.
 */
export function pending(account: string, artifactDir: string): MakeRequest[] {
  const p = join(artifactDir, "_callbacks.jsonl");
  if (!existsSync(p)) return [];
  const done = handled(account);
  const out: MakeRequest[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isMake(v) || done.has(requestKey(v))) continue;
    out.push(v);
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
