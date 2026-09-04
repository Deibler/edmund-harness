import type { ChatDb } from "../imessage/db.ts";
import { stripAssocPrefix, tapbackGlyph } from "../imessage/reactions.ts";
import type { SessionKey } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { log, shortSession } from "../util/log.ts";
import type { GhostPrefsStore } from "./prefs.ts";

/**
 * Outcome backfill — the missing half of engagement decay.
 *
 * `decayMultiplier` adjusts proactive cooldowns from fire outcomes, but
 * nothing ever WROTE outcomes: every fire sat at `outcome=null` forever
 * (both production fires from 2026-05-13 still null a month later), so
 * the system could never learn which proactive moves land. This sweep
 * closes the loop deterministically from observable behavior:
 *
 *   - the user sent ANY message in the chat within ENGAGED_WINDOW of the
 *     fire → "engaged" (they were drawn back into the conversation);
 *   - their first message came only after the window, or never came and
 *     the fire is older than IGNORE_AFTER → "ignored".
 *
 * "pushed_back" is deliberately NOT inferred here — tone is a judgment
 * call, and the persona already owns it: on push-back the model calls
 * `disable_brown_nose`, whose handler stamps the latest pending fire.
 */

/** A user reply within this window of a proactive fire counts as engagement. */
export const ENGAGED_WINDOW_MS = 12 * 3_600_000;
/** A fire with no reply after this long is marked ignored. */
export const IGNORE_AFTER_MS = 36 * 3_600_000;

/**
 * Pure classification. `firstInboundMs` is the timestamp of the user's
 * first TEXT message after the fire; `firstReaction` the first tapback
 * they left on one of the bot's messages after the fire (null if none).
 * Returns null while the verdict is still open.
 *
 * Precedence: a text reply is the stronger signal and wins over a
 * tapback in the same window. A tapback with no reply becomes
 * "reacted" + glyph — the lightest feedback channel iMessage offers,
 * previously invisible to the learning loop.
 */
export function classifyOutcome(args: {
  firedAtMs: number;
  firstInboundMs: number | null;
  firstReaction?: { atMs: number; glyph: string } | null;
  nowMs: number;
}): { outcome: "engaged" | "reacted" | "ignored"; glyph?: string } | null {
  if (args.firstInboundMs !== null && args.firstInboundMs - args.firedAtMs <= ENGAGED_WINDOW_MS) {
    return { outcome: "engaged" };
  }
  const reaction = args.firstReaction ?? null;
  if (reaction !== null && reaction.atMs - args.firedAtMs <= ENGAGED_WINDOW_MS) {
    return { outcome: "reacted", glyph: reaction.glyph };
  }
  if (args.firstInboundMs !== null) return { outcome: "ignored" };
  if (args.nowMs - args.firedAtMs > IGNORE_AFTER_MS) return { outcome: "ignored" };
  return null;
}

const FIRST_INBOUND_SQL = `
  SELECT ((m.date / 1000000) + 978307200000) AS ts_ms
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  WHERE c.guid = ?
    AND m.is_from_me = 0
    AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
    AND ((m.date / 1000000) + 978307200000) > ?
  ORDER BY m.date ASC
  LIMIT 1`;
// The associated_message_type filter excludes tapbacks (2000-2005) and
// tapback removals (3000-3005), which chat.db stores as ordinary message
// rows. Without it a 👎 on the proactive message scored as "engaged".
// (Reaction POLARITY becomes its own signal in the Phase-5 `reacted`
// outcome; here they must simply not masquerade as a reply.)

function firstInboundAfter(chatDb: ChatDb, chatGuid: string, sinceMs: number): number | null {
  const row = chatDb.query<{ ts_ms: number }>(FIRST_INBOUND_SQL).get(chatGuid, sinceMs) as
    | { ts_ms: number }
    | null
    | undefined;
  return row?.ts_ms ?? null;
}

// First user tapback (add events 2000-2005 only; removals 3000+ and
// custom stickers excluded) in the chat after the fire. The target must
// be one of the BOT's messages — a tapback on their own or a third
// party's message is not feedback on the proactive move.
const FIRST_REACTION_SQL = `
  SELECT r.associated_message_guid AS assoc,
         r.associated_message_type AS type,
         ((r.date / 1000000) + 978307200000) AS ts_ms
  FROM message r
  JOIN chat_message_join cmj ON cmj.message_id = r.ROWID
  JOIN chat c                ON c.ROWID = cmj.chat_id
  WHERE c.guid = ?
    AND r.is_from_me = 0
    AND r.associated_message_type BETWEEN 2000 AND 2005
    AND r.associated_message_guid IS NOT NULL
    AND ((r.date / 1000000) + 978307200000) > ?
  ORDER BY r.date ASC
  LIMIT 10`;

const TARGET_FROM_ME_SQL = "SELECT is_from_me AS from_me FROM message WHERE guid = ? LIMIT 1";

function firstReactionAfter(
  chatDb: ChatDb,
  chatGuid: string,
  sinceMs: number,
): { atMs: number; glyph: string } | null {
  const rows = chatDb
    .query<{ assoc: string; type: number; ts_ms: number }>(FIRST_REACTION_SQL)
    .all(chatGuid, sinceMs) as Array<{ assoc: string; type: number; ts_ms: number }>;
  for (const r of rows) {
    const target = chatDb
      .query<{ from_me: number }>(TARGET_FROM_ME_SQL)
      .get(stripAssocPrefix(r.assoc)) as { from_me: number } | null | undefined;
    if (target?.from_me === 1) {
      return { atMs: r.ts_ms, glyph: tapbackGlyph(r.type) };
    }
  }
  return null;
}

export type OutcomeSweepDeps = {
  prefs: GhostPrefsStore;
  chatDb: ChatDb;
  state: StateStore;
};

/** Stamp outcomes on pending fires. Cheap — runs over fires with
 *  outcome IS NULL only, which is a handful of rows at most. */
export function sweepFireOutcomes(deps: OutcomeSweepDeps, nowMs: number = Date.now()): void {
  for (const fire of deps.prefs.pendingOutcomes(50)) {
    try {
      const session = deps.state.getSession(fire.sessionKey as SessionKey);
      if (!session) continue;
      const firstInboundMs = firstInboundAfter(deps.chatDb, session.chatGuid, fire.firedAtMs);
      const firstReaction = firstReactionAfter(deps.chatDb, session.chatGuid, fire.firedAtMs);
      const verdict = classifyOutcome({
        firedAtMs: fire.firedAtMs,
        firstInboundMs,
        firstReaction,
        nowMs,
      });
      if (!verdict) continue;
      deps.prefs.recordOutcome(fire.id, verdict.outcome, verdict.glyph);
      log.info("brown-nose-outcome", verdict.glyph ? `reacted ${verdict.glyph}` : verdict.outcome, {
        session: shortSession(fire.sessionKey),
        fired_ago_h: Math.round((nowMs - fire.firedAtMs) / 3_600_000),
        brief: fire.brief.slice(0, 60),
      });
    } catch (err) {
      log.warn("brown-nose-outcome", "sweep error", {
        fire: fire.id,
        err: String(err).slice(0, 150),
      });
    }
  }
}
