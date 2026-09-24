/**
 * The questions the kitchen saves up, and what happens when nobody answers.
 *
 * Nobody wants to be asked about the onions on a Tuesday afternoon. The one
 * moment a household expects to hear from the kitchen is after a meal it was
 * sent: "Did you make the chicken? I think you're low on rice, add it?" So
 * suspicions about stock are held here until that follow-up, and asked as one
 * short yes/no text.
 *
 * Silence is an answer too. A suspicion nobody was asked about within a few
 * days (no meal was sent), or one that was asked and ignored, is assumed true:
 * the item is marked out or low in one retractable batch. The list then treats
 * it like any run-out, and shows a staple under "Assumed to be low/out:", where
 * a tick on the site says they still have it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDir } from "./accounts.ts";
import { ASSUMED_SRC, history } from "./history.ts";
import { append, fold, openPlans, readLog } from "./store.ts";
import type { KitchenEvent, Plan } from "./types.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long after a meal is sent before asking whether it was made. */
export const ASK_AFTER_HOURS = 18;
/** A plan older than this is not followed up; the moment has passed. */
export const ASK_WITHIN_DAYS = 4;
/** Local hours in which a follow-up may be sent. */
export const ASK_HOURS = { from: 11, to: 20 } as const;
/** A suspicion never asked about is assumed after this long. */
export const UNASKED_DAYS = 4;
/** A suspicion asked about and not answered is assumed after this long. */
export const UNANSWERED_DAYS = 2;
/** An item reviewed this recently is not put in front of the model again. */
export const REVIEW_EVERY_DAYS = 3;
/** A run-out offered in a follow-up is not offered again for this long. */
export const OFFER_EVERY_DAYS = 14;

export type Verdict = "gone" | "low";

export type Suspect = {
  name: string;
  verdict: Verdict;
  /** One clause, in words a person would accept: "bought 3 weeks ago, used in 2 meals". */
  reason: string;
  since: string;
  /** When it was put in a follow-up, if it has been. */
  asked?: string | null;
};

export type FollowupState = {
  suspects: Record<string, Suspect>;
  /** Plan id -> when its follow-up was sent. */
  plansAsked: Record<string, string>;
  /** Item id -> when the morning review last looked at it. */
  reviewed: Record<string, string>;
  /** Item id -> when it was last offered as "want me to add it?". */
  offered: Record<string, string>;
};

const empty = (): FollowupState => ({ suspects: {}, plansAsked: {}, reviewed: {}, offered: {} });

export function followupPath(account: string): string {
  return join(accountDir(), account, "followups.json");
}

export function readFollowups(account: string): FollowupState {
  const p = followupPath(account);
  if (!existsSync(p)) return empty();
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<FollowupState>;
    return {
      suspects: raw.suspects ?? {},
      plansAsked: raw.plansAsked ?? {},
      reviewed: raw.reviewed ?? {},
      offered: raw.offered ?? {},
    };
  } catch {
    return empty();
  }
}

function write(account: string, s: FollowupState): void {
  const p = followupPath(account);
  mkdirSync(join(accountDir(), account), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, p);
}

function update(account: string, fn: (s: FollowupState) => void): FollowupState {
  const s = readFollowups(account);
  fn(s);
  write(account, s);
  return s;
}

const iso = (t: number) => new Date(t).toISOString();

/** Hold a suspicion until the next follow-up. An existing one keeps its original date. */
export function suspect(
  account: string,
  entries: Array<{ id: string; name: string; verdict: Verdict; reason: string }>,
  now = Date.now(),
): void {
  if (!entries.length) return;
  update(account, (s) => {
    for (const e of entries) {
      const was = s.suspects[e.id];
      s.suspects[e.id] = {
        name: e.name,
        verdict: e.verdict,
        reason: e.reason,
        since: was?.since ?? iso(now),
        asked: was?.asked ?? null,
      };
    }
  });
}

/** Forget suspicions, because somebody answered or the item came back. */
export function clearSuspects(account: string, ids: string[]): number {
  let n = 0;
  update(account, (s) => {
    for (const id of ids) if (s.suspects[id] && delete s.suspects[id]) n++;
  });
  return n;
}

export function markReviewed(account: string, ids: string[], now = Date.now()): void {
  if (!ids.length) return;
  update(account, (s) => {
    for (const id of ids) s.reviewed[id] = iso(now);
  });
}

export function reviewedRecently(s: FollowupState, id: string, now = Date.now()): boolean {
  const at = s.reviewed[id];
  return Boolean(at) && now - Date.parse(at!) < REVIEW_EVERY_DAYS * DAY;
}

export type Due = {
  plan: Plan;
  /** Suspicions to raise in the same text. */
  suspects: Array<{ id: string } & Suspect>;
};

/** Whether a run-out may be offered again, or was offered too recently. */
export function mayOffer(s: FollowupState, id: string, now = Date.now()): boolean {
  const at = s.offered[id];
  return !at || now - Date.parse(at) >= OFFER_EVERY_DAYS * DAY;
}

/**
 * The follow-up owed right now, if any: the oldest meal sent between
 * `ASK_AFTER_HOURS` and `ASK_WITHIN_DAYS` ago that nobody has been asked about,
 * during waking hours. Suspicions ride along with it; on their own they wait.
 */
export function followupDue(account: string, now = new Date()): Due | null {
  const hour = now.getHours();
  if (hour < ASK_HOURS.from || hour >= ASK_HOURS.to) return null;
  const s = readFollowups(account);
  const t = now.getTime();
  const plan = Object.values(openPlans(account))
    .filter((p) => !s.plansAsked[p.id])
    .filter((p) => {
      const age = t - Date.parse(p.created);
      return age >= ASK_AFTER_HOURS * HOUR && age <= ASK_WITHIN_DAYS * DAY;
    })
    .sort((a, b) => a.created.localeCompare(b.created))[0];
  if (!plan) return null;
  const suspects = Object.entries(s.suspects)
    .filter(([, x]) => !x.asked)
    .map(([id, x]) => ({ id, ...x }));
  return { plan, suspects };
}

export function markAsked(
  account: string,
  asked: { plan: string; suspects: string[]; offered: string[] },
  now = Date.now(),
): void {
  update(account, (s) => {
    s.plansAsked[asked.plan] = iso(now);
    for (const id of asked.suspects) {
      const x = s.suspects[id];
      if (x) x.asked = iso(now);
    }
    for (const id of asked.offered) s.offered[id] = iso(now);
    // Plans are only ever followed up inside a few days, so older marks are noise.
    for (const [id, at] of Object.entries(s.plansAsked)) {
      if (now - Date.parse(at) > 30 * DAY) delete s.plansAsked[id];
    }
  });
}

export type Settled = {
  /** Suspicions made true because nobody said otherwise. */
  assumed: Array<{ id: string; name: string; verdict: Verdict }>;
  /** Suspicions dropped because the item was bought, seen or used up since. */
  dropped: string[];
  batch: string | null;
};

/**
 * Resolve suspicions that have waited long enough.
 *
 * One that the kitchen has since contradicted (the item was bought again, seen
 * on a shelf, or finished) is dropped. One that was asked and ignored for
 * `UNANSWERED_DAYS`, or never asked for `UNASKED_DAYS`, is assumed: written to
 * the ledger in one batch stamped `assumed`, so one undo restores all of it.
 */
export function settleSuspects(account: string, now = Date.now()): Settled {
  const s = readFollowups(account);
  const ids = Object.keys(s.suspects);
  if (!ids.length) return { assumed: [], dropped: [], batch: null };

  const events = readLog(account);
  const items = fold(account, events);
  const h = history(events);
  const out: Settled = { assumed: [], dropped: [], batch: null };
  const writes: Partial<KitchenEvent>[] = [];

  for (const id of ids) {
    const x = s.suspects[id]!;
    const it = items[id];
    const since = Date.parse(x.since);
    const past = h.items.get(id);
    const contradicted =
      !it ||
      it.gone ||
      (past?.lastBought && Date.parse(past.lastBought) > since) ||
      (past?.lastSeen && Date.parse(past.lastSeen) > since);
    if (contradicted) {
      out.dropped.push(id);
      continue;
    }
    const waited = x.asked
      ? now - Date.parse(x.asked) >= UNANSWERED_DAYS * DAY
      : now - since >= UNASKED_DAYS * DAY;
    if (!waited) continue;
    out.assumed.push({ id, name: x.name, verdict: x.verdict });
    writes.push(
      x.verdict === "gone"
        ? { op: "use", item: id, qty: null, why: `assumed gone: ${x.reason}`, src: ASSUMED_SRC }
        : {
            op: "set",
            item: id,
            fields: { level: "low" },
            why: `assumed low: ${x.reason}`,
            src: ASSUMED_SRC,
          },
    );
  }

  if (writes.length) out.batch = append(account, writes);
  const resolved = [...out.dropped, ...out.assumed.map((a) => a.id)];
  if (resolved.length) {
    update(account, (st) => {
      for (const id of resolved) delete st.suspects[id];
    });
  }
  return out;
}
