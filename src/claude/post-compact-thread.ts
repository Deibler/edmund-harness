/**
 * Put the conversation's own words back after every compaction.
 *
 * A compaction replaces the conversation with a summary, and a summary keeps
 * pointers, not words. the operator's DM compacted every 1.2 hours (median, week of
 * 2026-10-26), and most of those compactions were the CLI's own, mid-turn,
 * where no instruction reaches the summariser. On 10-26 the summary held the
 * path of a draft instead of the post the operator had published, and the next
 * reply rebuilt the post from the draft. On 10-19 one long turn compacted 17
 * times, and what he asked for at its start was paraphrased again each time.
 *
 * Claude Code runs SessionStart hooks with the `compact` matcher after every
 * compaction, automatic or manual, and adds what they print to the compacted
 * context (code.claude.com/docs/en/hooks-guide, "Re-inject context after
 * compaction"). This is that hook: the latest messages of the chat, read
 * from chat.db (the system of record), oldest first, within a fixed budget.
 * Recall excludes the same window as already in sight (recentThreadWindow).
 *
 * Run by the CLI as `bun <this file>`, with the worker's environment
 * (EDMUND_SESSION_KEY, EDMUND_CONFIG_PATH, EDMUND_DATA_DIR). It prints
 * nothing on any failure: a missing thread must never cost the turn.
 */
import { POST_COMPACT_THREAD_CHARS, recentThreadWindow } from "../channels/history.ts";
import { loadConfig } from "../config/config.ts";
import { ChatDb } from "../imessage/db.ts";
import { AddressBook } from "../sessions/address-book.ts";
import { ContactBook } from "../sessions/contacts.ts";
import type { SessionKey } from "../sessions/key.ts";
import { LearnedNames } from "../sessions/learned-names.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import { StateStore } from "../sessions/store.ts";

/** The text the hook adds after a compaction, or "" when there is no thread. */
export function postCompactContext(lines: string[]): string {
  if (lines.length === 0) return "";
  return [
    "The conversation was just compacted, and the summary above paraphrases it. These are the " +
      "latest messages in this chat exactly as they were sent, oldest first. Where the summary " +
      "and these disagree, these are right: quote and act from these.",
    ...lines,
  ].join("\n");
}

function main(): void {
  const sessionKey = process.env.EDMUND_SESSION_KEY as SessionKey | undefined;
  if (!sessionKey) return;
  const config = loadConfig(process.env.EDMUND_CONFIG_PATH ?? "./config.toml");
  const dataDir = process.env.EDMUND_DATA_DIR ?? config.paths.data_dir;
  const chatDb = new ChatDb(config.paths.chat_db);
  const contacts = new ContactBook(config.contacts, new AddressBook(), new LearnedNames(dataDir));
  const chatGuid = chatGuidsForSession(sessionKey, chatDb, contacts)[0];
  if (!chatGuid) return;
  const state = config.orchestrators.length > 0 ? new StateStore(dataDir) : null;
  const { formatted } = recentThreadWindow(
    sessionKey,
    chatGuid,
    { config, chatDb, contacts, state },
    { budgetChars: POST_COMPACT_THREAD_CHARS },
  );
  const additionalContext = postCompactContext(formatted);
  if (!additionalContext) return;
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } })}\n`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`post-compact-thread: ${(err as Error).message}\n`);
  }
  process.exit(0);
}
