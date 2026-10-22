/**
 * People who ask about food with no kitchen yet, and where each stands with the
 * offer of one.
 *
 * The offer used to wait for "the second or third time" somebody asked, which
 * nothing counted, so it was almost never made: 2 offers in about 30 food
 * questions from 7 chats between 2026-08-17 and 2026-10-20. It is now made on
 * the first food question, after the answer, and this file is what keeps it
 * from being made on every one after that.
 *
 * Only what cannot be derived is stored: when they asked, when they were
 * offered, and a no. Whether to offer is computed from those each time.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseDir } from "./accounts.ts";

export type Prospect = {
  /** One timestamp per food question; a burst of messages counts once. */
  asks: string[];
  /** When the offer was put to them. */
  offers: string[];
  /** When they said no. Final unless they raise it themselves. */
  declined?: string | null;
};

type ProspectFile = { version: 1; people: Record<string, Prospect> };

/** Messages this close together are one question. */
const ASK_GAP_MS = 30 * 60_000;
/** An offer this recent is the one being made in the current turn. */
export const SAME_TURN_MS = 10 * 60_000;
/** How long an offer may go unanswered before it is made once more. */
export const AGAIN_AFTER_MS = 7 * 86_400_000;
/** Unanswered this many times is a no. */
export const MAX_OFFERS = 2;
const KEEP_ASKS = 20;

export type Decision =
  /** Put it to them this turn. `again` when they have heard it once before. */
  | { kind: "offer"; again: boolean }
  /** Offered recently with no answer yet: answer the question, nothing more. */
  | { kind: "wait"; since: string }
  /** Never again unless they raise it. */
  | { kind: "stop"; why: "declined" | "unanswered"; since: string };

const path = () => join(baseDir(), "prospects.json");

function load(): ProspectFile {
  if (!existsSync(path())) return { version: 1, people: {} };
  try {
    const raw = JSON.parse(readFileSync(path(), "utf8")) as ProspectFile;
    return raw?.people ? raw : { version: 1, people: {} };
  } catch {
    return { version: 1, people: {} };
  }
}

function save(f: ProspectFile): void {
  const tmp = `${path()}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2));
  renameSync(tmp, path());
}

function update(principal: string, fn: (p: Prospect) => void): Prospect {
  const f = load();
  const p = f.people[principal] ?? { asks: [], offers: [] };
  fn(p);
  f.people[principal] = p;
  save(f);
  return p;
}

export function prospect(principal: string): Prospect {
  return load().people[principal] ?? { asks: [], offers: [] };
}

/** Whether to offer, from what has happened so far. */
export function decide(p: Prospect, now = Date.now()): Decision {
  if (p.declined) return { kind: "stop", why: "declined", since: p.declined };
  const last = p.offers.at(-1);
  if (!last) return { kind: "offer", again: false };
  const ago = now - Date.parse(last);
  if (ago < SAME_TURN_MS) return { kind: "offer", again: p.offers.length > 1 };
  if (p.offers.length >= MAX_OFFERS) return { kind: "stop", why: "unanswered", since: last };
  if (ago < AGAIN_AFTER_MS) return { kind: "wait", since: last };
  return { kind: "offer", again: true };
}

/**
 * Count a food question, drop any recorded offer that never reached the chat,
 * decide, and record the offer when one is due.
 *
 * `delivered` answers from the message database whether a reply carrying the
 * offer went out after the given time: true, false, or null when it cannot
 * tell. An offer is recorded when the model is told to make it, so one the
 * model skipped would otherwise silence the next chance for a week.
 */
export function consider(
  principal: string,
  opts: { now?: number; delivered?: (at: string) => boolean | null } = {},
): { prospect: Prospect; decision: Decision } {
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  let decision: Decision = { kind: "offer", again: false };
  const p = update(principal, (p) => {
    const lastAsk = p.asks.at(-1);
    if (!lastAsk || now - Date.parse(lastAsk) >= ASK_GAP_MS)
      p.asks = [...p.asks, at].slice(-KEEP_ASKS);
    p.offers = p.offers.filter(
      (o) => now - Date.parse(o) < SAME_TURN_MS * 2 || opts.delivered?.(o) !== false,
    );
    decision = decide(p, now);
    const last = p.offers.at(-1);
    if (decision.kind === "offer" && (!last || now - Date.parse(last) >= SAME_TURN_MS)) {
      p.offers = [...p.offers, at];
    }
  });
  return { prospect: p, decision };
}

export function decline(principal: string, now = Date.now()): Prospect {
  return update(principal, (p) => {
    p.declined = new Date(now).toISOString();
  });
}

/** They have a kitchen now; nothing here applies any more. */
export function forget(principal: string): void {
  const f = load();
  if (!f.people[principal]) return;
  delete f.people[principal];
  save(f);
}
