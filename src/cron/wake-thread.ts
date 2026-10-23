import type { Config } from "../config/config.ts";
import { startsCold } from "../model/runner.ts";
import { type SessionKey, isGroupSession } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { log } from "../util/log.ts";

/** What a cold wake-up is shown about its conversation (see wakeThread). */
export type WakeThread = {
  /** `Participants:` labels for a group; empty for a DM. */
  participants: string[];
  /** The latest messages as envelope lines. */
  lines: string[];
};

/** Reads a session's roster and latest messages (see channels/history.ts
 *  wakeThread), only those after `sinceMs` when given. */
export type RecentThread = (
  sessionKey: SessionKey,
  chatGuid: string,
  sinceMs?: number,
) => WakeThread;

/**
 * The envelope block for a scheduled or proactive wake-up.
 *
 * A cold one (27 of 5,075 scheduled fires in the daemon log to 2026-09-24)
 * used to get only the event text, while an inbound cold start gets the
 * recent thread. A warm DM already has the conversation and gets nothing. A
 * warm group does not: messages that don't address Edmund start no turn, so
 * the resumed conversation ends at its last turn, and 32 of 66 group fires
 * (2026-10-23) woke without what members had said since. Those get the
 * messages after the last turn. Empty string when there is nothing to add. A
 * failed read is logged and skipped: the event still fires.
 */
export function wakeThreadBlock(
  sessionKey: SessionKey,
  chatGuid: string,
  config: Config,
  state: StateStore,
  recentThread: RecentThread,
): string {
  const cold = startsCold(sessionKey, config, state);
  if (!cold && !isGroupSession(sessionKey)) return "";
  const session = cold ? null : state.getSession(sessionKey);
  const sinceMs = session ? Math.max(session.lastInboundMs, session.lastOutboundMs) : undefined;
  let thread: WakeThread;
  try {
    thread = recentThread(sessionKey, chatGuid, sinceMs);
  } catch (err) {
    log.warn("wake", "could not read the recent thread for a cold wake-up", {
      session: sessionKey,
      err: (err as Error).message,
    });
    return "";
  }
  const { lines } = thread;
  if (!cold) {
    if (lines.length === 0) return "";
    log.info("wake", "group wake-up carries what was said since its last turn", {
      session: sessionKey,
      lines: lines.length,
    });
    return [
      "Said in this group since your last turn here (you have not seen these yet):",
      ...lines,
    ].join("\n");
  }
  const { participants } = thread;
  if (lines.length === 0 && participants.length === 0) return "";
  log.info("wake", "cold wake-up carries the recent thread", {
    session: sessionKey,
    lines: lines.length,
    participants: participants.length,
  });
  // Same `Participants:` line an inbound group envelope carries. Without it a
  // reminder written days earlier can only guess who is in the room from
  // who happened to speak lately, and people merely talked about read as
  // present.
  return [
    ...(participants.length > 0 ? [`Participants: ${participants.join(", ")}`] : []),
    ...(lines.length > 0
      ? [
          "Recent thread (this turn starts without the conversation's earlier context, so here are its latest messages):",
          ...lines,
        ]
      : []),
  ].join("\n");
}
