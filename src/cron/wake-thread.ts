import type { Config } from "../config/config.ts";
import { startsCold } from "../model/runner.ts";
import type { SessionKey } from "../sessions/key.ts";
import type { StateStore } from "../sessions/store.ts";
import { log } from "../util/log.ts";

/** Reads a session's latest messages as envelope lines (see recentThreadLines). */
export type RecentThread = (sessionKey: SessionKey, chatGuid: string) => string[];

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
  let lines: string[];
  try {
    lines = recentThread(sessionKey, chatGuid);
  } catch (err) {
    log.warn("wake", "could not read the recent thread for a cold wake-up", {
      session: sessionKey,
      err: (err as Error).message,
    });
    return "";
  }
  if (lines.length === 0) return "";
  log.info("wake", "cold wake-up carries the recent thread", {
    session: sessionKey,
    lines: lines.length,
  });
  return [
    "Recent thread (this turn starts without the conversation's earlier context, so here are its latest messages):",
    ...lines,
  ].join("\n");
}
