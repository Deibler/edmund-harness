/**
 * Typed reader for taps on the household site.
 *
 * The site is static, so buttons POST to the share server's `/callback`
 * endpoint, which appends the JSON body to `_callbacks.jsonl` beside the page.
 * The watch pass settles the arithmetic ones (`drain.ts`) and wakes a session
 * for the rest (`wake.ts`).
 *
 * The callbacks file is append-only and owned by the share server, so served
 * requests are recorded by key rather than deleted. Serving one twice would text
 * a person the same thing twice.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";

/** Everything the page can ask for. A closed set. */
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
  /** Server-stamped time: authoritative, but only second-resolution. */
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
   * keep: the shopping line the answer is about (a ledger slug, or a written
   * line's key). Separate from `item`, which is validated against live stock,
   * because a keep usually names something the kitchen no longer has.
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
  /** pref: the per-dinner ceiling (the weekly budget rides in `qty`). Bodies stay flat. */
  amount?: number | null;
  /**
   * sched: a standing dinner text. The verb rides in `note` ("save", "pause",
   * "delete"), recipients in `users`, weekdays in `days`, the time in `at`.
   * Validated against the household on arrival.
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
 * The dedup identity of a request. The server timestamp alone is too coarse:
 * two different taps in one second would collide. With the verb and dish in the
 * key, only a genuine double-tap collides.
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
    // Fail closed: an unreadable record would otherwise re-serve every request.
    throw new Error(`kitchen: cannot read ${p}; refusing to re-serve requests blindly`);
  }
}

/**
 * Record requests as served. Written via temp file and rename, because
 * `handled` fails closed on a torn file and this runs on every tap.
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
 * Unserved requests in an artifact's callback log, oldest first. Malformed lines
 * are skipped: the file is written by a public endpoint.
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
