import type { Config } from "../config/config.ts";
import { startsCold } from "../model/runner.ts";
import type { SessionKey } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { log } from "../util/log.ts";

/** What a cold wake-up is shown about its conversation (see wakeThread). */
export type WakeThread = {
  /** `Participants:` labels for a group; empty for a DM. */
  participants: string[];
  /** The latest messages as envelope lines. */
  lines: string[];
};

/** Reads a session's roster and latest messages (see channels/history.ts wakeThread). */
export type RecentThread = (sessionKey: SessionKey, chatGuid: string) => WakeThread;

/**
 * The envelope block for a scheduled or proactive wake-up that starts cold.
 *
 * A wake-up that resumes the session already has the conversation, so it gets
 * nothing. A cold one (27 of 5,075 scheduled fires in the daemon log to
 * 2026-09-24) used to get only the event text, while an inbound cold start
 * gets the recent thread. Empty string when there is nothing to add. A failed
 * read is logged and skipped: the event still fires.
 */
export function wakeThreadBlock(
  sessionKey: SessionKey,
  chatGuid: string,
  config: Config,
  state: StateStore,
  recentThread: RecentThread,
): string {
  if (!startsCold(sessionKey, config, state)) return "";
  let thread: WakeThread;
  try {
    thread = recentThread(sessionKey, chatGuid);
  } catch (err) {
    log.warn("wake", "could not read the recent thread for a cold wake-up", {
      session: sessionKey,
      err: (err as Error).message,
    });
    return "";
  }
  const { participants, lines } = thread;
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
