/**
 * The morning inventory pass for one household.
 *
 * 1. Suspicions that have waited long enough are settled (`settleSuspects`).
 * 2. Items the kitchen is unsure of, and has not put in front of the model in
 *    the last few days, go to the household's main session for a review.
 * 3. Items past any reasonable doubt are also held as suspicions directly, so
 *    they reach the follow-up even if the review is never answered.
 *
 * Nothing here messages anyone. The only text a household receives from the
 * kitchen is the follow-up after a meal, and the requests they made themselves.
 */

import { type Evidence, evidence } from "./evidence.ts";
import {
  type Settled,
  markReviewed,
  readFollowups,
  reviewedRecently,
  settleSuspects,
  suspect,
} from "./followups.ts";
import type { Account } from "./types.ts";
import { REVIEW_MAX, type WakeOpts, type WakeResult, wakeForReview } from "./wake.ts";

export type ReviewResult = {
  settled: Settled;
  /** Items handed to the model for review. */
  reviewed: string[];
  /** Items held as suspicions without waiting for the review. */
  held: string[];
  wake: WakeResult | null;
};

export function morningReview(
  account: string,
  acct: Account,
  opts: { now?: number; create?: WakeOpts["create"] } = {},
): ReviewResult {
  const now = opts.now ?? Date.now();
  const settled = settleSuspects(account, now);
  const state = readFollowups(account);
  const fresh = (e: Evidence) =>
    !state.suspects[e.item.id] && !reviewedRecently(state, e.item.id, now);

  const doubtful = evidence(account, { now }).filter(
    (e) => (e.estimate === "unsure" || e.estimate === "doubtful") && fresh(e),
  );
  const backstop = doubtful.filter((e) => e.estimate === "doubtful");
  suspect(
    account,
    backstop.map((e) => ({
      id: e.item.id,
      name: e.item.name,
      verdict: "gone" as const,
      reason: e.reasons.slice(0, 2).join("; "),
    })),
    now,
  );

  const shown = doubtful.slice(0, REVIEW_MAX);
  const wake = shown.length
    ? wakeForReview(account, acct, shown, { now, ...(opts.create ? { create: opts.create } : {}) })
    : null;
  // Shown counts as reviewed, answered or not, so the same item is not put in
  // front of the model every morning.
  if (wake?.woke.length)
    markReviewed(
      account,
      shown.map((e) => e.item.id),
      now,
    );

  return {
    settled,
    reviewed: shown.map((e) => e.item.id),
    held: backstop.map((e) => e.item.id),
    wake,
  };
}
