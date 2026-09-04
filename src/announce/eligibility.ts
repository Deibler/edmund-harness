/**
 * Who may be told about a new capability.
 *
 * This is the whole risk of the feature. An unprompted product pitch to
 * someone who texts twice a month reads as spam from a friend, and you only
 * get to do that once — there is no version of "sorry, ignore that" that
 * undoes it. So the gate is deliberately strict, everything is measured
 * against chat.db rather than inferred, and every rule fails CLOSED.
 *
 * The engagement measure is DISTINCT ACTIVE DAYS, not message count. One
 * person sending forty messages in a single afternoon is having one
 * conversation; someone sending two messages a day for three weeks is a
 * regular. Only the second has a relationship where "here's a thing you can
 * now do" is welcome rather than intrusive.
 *
 * The threshold was set from the real distribution rather than picked. Over
 * the 30 days to 2026-08-29, across 29 people who wrote in:
 *
 *     >= 20 active days ......  7 people   (daily, unmistakably)
 *     >= 12 active days ...... 11 people   ← the floor
 *     <=  3 active days ...... 11 people   (the once-a-fortnight texter)
 *
 * Twelve puts a clear gap on both sides: nobody near the line is ambiguous,
 * and the 11 occasional texters — 38% of everyone — are excluded outright.
 */

import type { ChatDb } from "../imessage/db.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { type SessionKey, chatIdFromKey, isDmSession, normalizeHandle } from "../sessions/key.ts";

/** Apple epoch (2001-01-01) in unix ms — chat.db stores nanoseconds from it. */
const APPLE_EPOCH_MS = 978_307_200_000;

const ACTIVE_DAYS_SQL = `
  SELECT COUNT(DISTINCT date((m.date/1000000000) + 978307200, 'unixepoch', 'localtime')) AS days
    FROM message m
    JOIN handle h ON h.ROWID = m.handle_id
   WHERE m.is_from_me = 0
     AND h.id IN (SELECT value FROM json_each(?))
     AND m.date >= ?
`;

const FIRST_SEEN_SQL = `
  SELECT MIN(m.date) AS first
    FROM message m
    JOIN handle h ON h.ROWID = m.handle_id
   WHERE h.id IN (SELECT value FROM json_each(?))
`;

/**
 * Distinct days this person wrote in, over the trailing window.
 *
 * Every alias for the person counts toward one total — someone who texts from
 * a phone on weekdays and an iCloud address at weekends is one regular, not
 * two occasionals.
 */
export function activeDays(
  chatDb: ChatDb,
  handles: string[],
  windowDays: number,
  now = Date.now(),
): number {
  if (handles.length === 0) return 0;
  const sinceApple = (now - windowDays * 86_400_000 - APPLE_EPOCH_MS) * 1_000_000;
  const row = chatDb
    .query<{ days: number }>(ACTIVE_DAYS_SQL)
    .get(JSON.stringify(handles), sinceApple);
  return row?.days ?? 0;
}

/** How long this person has been writing in at all, in days. */
export function tenureDays(chatDb: ChatDb, handles: string[], now = Date.now()): number {
  if (handles.length === 0) return 0;
  const row = chatDb.query<{ first: number | null }>(FIRST_SEEN_SQL).get(JSON.stringify(handles));
  if (!row?.first) return 0;
  const firstMs = row.first / 1_000_000 + APPLE_EPOCH_MS;
  return Math.max(0, Math.floor((now - firstMs) / 86_400_000));
}

export type EligibilityConfig = {
  window_days: number;
  min_active_days: number;
  min_tenure_days: number;
  cooldown_days: number;
  max_offers: number;
};

export type EligibilityInput = {
  sessionKey: SessionKey;
  chatDb: ChatDb;
  contacts: ContactBook;
  /** Guest tier of this session's sender, or null for a full-access person. */
  guestTier: string | null;
  /** Most recent offer of ANY announcement to this conversation. 0 = never. */
  lastOfferMs: number;
  config: EligibilityConfig;
  /** Per-announcement override of `min_active_days`. */
  minActiveDaysOverride?: number | null;
  now?: number;
};

export type Eligibility =
  | { eligible: true; activeDays: number }
  | { eligible: false; reason: string };

/**
 * May this conversation be told about something right now?
 *
 * Ordered cheapest-first, and every branch names why — the reasons are shown
 * by `edmund announce status`, which is how an operator answers "why didn't
 * so-and-so get it?" without reading a log.
 */
export function checkEligibility(input: EligibilityInput): Eligibility {
  const now = input.now ?? Date.now();
  const { config, sessionKey } = input;

  // Groups never. A group contains whoever it contains — announcing there
  // reaches people who did not individually clear this bar, and it is the
  // one place a pitch is guaranteed to have an audience that did not want it.
  if (!isDmSession(sessionKey)) {
    return { eligible: false, reason: "not a direct message" };
  }
  // Guests are here on a campaign key with a reduced tool surface. Pitching
  // them capabilities they cannot reach would be a worse experience, not a
  // better one.
  if (input.guestTier) return { eligible: false, reason: `guest session (${input.guestTier})` };

  if (input.lastOfferMs > 0) {
    const sinceDays = (now - input.lastOfferMs) / 86_400_000;
    if (sinceDays < config.cooldown_days) {
      return {
        eligible: false,
        reason: `heard about something ${Math.floor(sinceDays)}d ago (cooldown ${config.cooldown_days}d)`,
      };
    }
  }

  const handle = normalizeHandle(chatIdFromKey(sessionKey));
  const handles = input.contacts.aliasesFor(handle);

  const tenure = tenureDays(input.chatDb, handles, now);
  if (tenure < config.min_tenure_days) {
    return {
      eligible: false,
      reason: `only known them ${tenure}d (need ${config.min_tenure_days}d)`,
    };
  }

  const floor = input.minActiveDaysOverride ?? config.min_active_days;
  const days = activeDays(input.chatDb, handles, config.window_days, now);
  if (days < floor) {
    return {
      eligible: false,
      reason: `wrote on ${days} of the last ${config.window_days} days (need ${floor})`,
    };
  }

  return { eligible: true, activeDays: days };
}
