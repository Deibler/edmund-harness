import { cooldownJitterFactor } from "../ghost/budget.ts";
import type { Ideation } from "./store.ts";

/**
 * How often one person gets a page, modeled on brown-nose pacing
 * (src/ghost/budget.ts) and a little looser, because a page has more to
 * offer than a proactive text.
 *
 * Without this, any conversation that touched a recurring interest could
 * produce a page, and everyone with one got a page a week, on the day the
 * week ran out. That is a rhythm people learn, and it reads as a system, not
 * as someone who thought of them. So, as the ghost does:
 *
 *  - The gap after a page reached them is jittered, seeded from the page,
 *    7 to 21 days, so no two gaps are the same and none can be counted on.
 *  - It stretches when pages land flat: a page they didn't answer within 36
 *    hours (the ghost's outcome window) counts as ignored, and consecutive
 *    ignored pages multiply the gap by 1.5, 2, then 3. Two answered in a row
 *    shorten it to 0.75. Replies come from chat.db: the page's open counter
 *    also counts the link-preview and tool fetches made when the link is
 *    sent, so it can't say whether a person looked.
 *  - One at a time: no new page while one is building or still waiting to
 *    be given (the ghost's "one open proactive thread").
 *  - Few on any one day across everyone, because the people Edmund talks to
 *    know each other and compare notes. Three people got a page within 20
 *    minutes of the first live hour (2026-11-03).
 *  - A pass that finds nothing to build waits 2 to 6 days before the next
 *    look, instead of re-reading the same month of messages every day.
 *
 * Pure functions over rows; the caller supplies the chat.db reply check.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** After a page reached them: this many days, times jitter [1, 3) and decay. */
export const PAGE_GAP_DAYS = 7;
/** A build that went nowhere (failed, taken down, never handed over) holds them this long. */
export const RETRY_GAP_DAYS = 7;
/** They wrote back within this long of a page: it landed. The ghost uses the same window. */
export const REPLY_WINDOW_MS = 36 * HOUR;
/** A held page is offered on their messages for this long, then let go (and counts as ignored). */
export const HOLD_MS = 14 * DAY;
/** Pages started per rolling day, across everyone. */
export const MAX_BUILDS_PER_DAY = 2;
/** After a pass that found nothing, the next look waits this many days times jitter [1, 3). */
export const NOTHING_GAP_DAYS = 2;
/** After any other pass (a gate turned it back, or it failed), the next look waits this long. */
export const RUN_INTERVAL_MS = 20 * HOUR;

export type Gate = { ok: true } | { ok: false; why: string };
export type Landing = "engaged" | "ignored" | "pending";
/** Did they write in this chat between the two times? (chat.db) */
export type RepliedBetween = (fromMs: number, toMs: number) => boolean;

/** The ghost's jitter in [1, 3), stable for a given seed (a page id, a run time). */
export function jitterFor(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  return cooldownJitterFactor(h);
}

/** Still waiting for a natural moment: handed to Edmund, not yet given, not yet let go. */
export function isHeld(i: Ideation, nowMs: number): boolean {
  return (
    i.status === "ready" &&
    i.announcedMs !== null &&
    i.deliveredMs === null &&
    nowMs - (i.readyMs ?? i.announcedMs) < HOLD_MS
  );
}

/**
 * How a page landed, or null when it never reached them and was not let go
 * (building, failed, taken down before it was given, a dry run, still held).
 */
export function landing(i: Ideation, nowMs: number, replied: RepliedBetween): Landing | null {
  if (i.deliveredMs !== null) {
    if (replied(i.deliveredMs, i.deliveredMs + REPLY_WINDOW_MS)) return "engaged";
    return nowMs - i.deliveredMs < REPLY_WINDOW_MS ? "pending" : "ignored";
  }
  const heldFrom = i.readyMs ?? i.announcedMs;
  if (i.status === "ready" && i.announcedMs !== null && heldFrom !== null) {
    // Held two weeks and no moment came, nor did the fallback go out.
    if (nowMs - heldFrom >= HOLD_MS) return "ignored";
  }
  return null;
}

/**
 * The ghost's engagement decay, over the newest settled outcomes first:
 * consecutive ignored pages stretch the gap; two answered in a row shorten it.
 */
export function decayFor(outcomes: Array<"engaged" | "ignored">): number {
  let ignored = 0;
  for (const o of outcomes) {
    if (o !== "ignored") break;
    ignored++;
  }
  if (ignored > 0) return [1, 1.5, 2, 3][Math.min(ignored, 3)] ?? 3;
  return outcomes[0] === "engaged" && outcomes[1] === "engaged" ? 0.75 : 1;
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

/** May a new page be started for this person now? `pages` are all of theirs. */
export function pageGate(pages: Ideation[], nowMs: number, replied: RepliedBetween): Gate {
  const newest = [...pages].sort((a, b) => b.createdMs - a.createdMs);
  if (newest.some((i) => i.status === "building")) {
    return { ok: false, why: "a page for them is still being built" };
  }
  if (newest.some((i) => isHeld(i, nowMs))) {
    return { ok: false, why: "a page for them is still waiting to be given" };
  }
  const last = newest[0];
  if (!last) return { ok: true };
  const lastLanding = landing(last, nowMs, replied);
  if (lastLanding === null) {
    const until = last.createdMs + RETRY_GAP_DAYS * DAY;
    return nowMs < until
      ? { ok: false, why: `their last build went nowhere; next try after ${day(until)}` }
      : { ok: true };
  }
  const settled = newest
    .map((i) => landing(i, nowMs, replied))
    .filter((o): o is "engaged" | "ignored" => o === "engaged" || o === "ignored");
  const jitter = jitterFor(last.id);
  const decay = decayFor(settled);
  const from = last.deliveredMs ?? (last.readyMs ?? last.createdMs) + HOLD_MS;
  const until = from + PAGE_GAP_DAYS * DAY * jitter * decay;
  if (nowMs >= until) return { ok: true };
  return {
    ok: false,
    why: `last page ${last.deliveredMs !== null ? `given ${day(last.deliveredMs)}` : "let go"}; next not before ${day(until)} (${jitter.toFixed(2)}× jitter, ${decay}× from how the last ones landed)`,
  };
}

/** Few pages on any one day, across everyone. */
export function dailyGate(startedInLastDay: number): Gate {
  return startedInLastDay < MAX_BUILDS_PER_DAY
    ? { ok: true }
    : { ok: false, why: `${startedInLastDay} pages already started in the last day, for anyone` };
}

/** When this person's next ideator pass may run, after their last one. */
export function nextLookMs(last: { ranMs: number; outcome: string } | null): number | null {
  if (!last) return null;
  if (last.outcome === "none") {
    return last.ranMs + NOTHING_GAP_DAYS * DAY * jitterFor(String(last.ranMs));
  }
  return last.ranMs + RUN_INTERVAL_MS;
}
