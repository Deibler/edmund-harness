/**
 * What the person actually asked for, read from chat.db.
 *
 * The safety check weighs an action against the request. The model's own
 * explanation is one account of that request, and a manipulated model would
 * give a false one, so the classifier also gets the person's latest messages
 * from the system of record.
 */

import type { Config } from "../../config/config.ts";
import { CronStore } from "../../cron/store.ts";
import type { CronJob } from "../../cron/types.ts";
import { ChatDb } from "../../imessage/db.ts";
import { getRecentMessages } from "../../imessage/history.ts";
import { AddressBook } from "../../sessions/address-book.ts";
import { ContactBook } from "../../sessions/contacts.ts";
import { chatGuidsForSession } from "../../sessions/session-scope.ts";
import { readTurn } from "./turn.ts";

const MESSAGES = 3;
const SCAN = 30;
const MAX_CHARS = 500;
/**
 * Enough for a whole kitchen wake: the classifier compares a deletion with the
 * lines the event says the note should have, so cutting the event off before
 * them (it was 800) left every deletion looking unrequested.
 */
const EVENT_CHARS = 4000;

/**
 * A reader for the latest messages people sent in this session's chats,
 * oldest first, each with who said it ("Sam: draw us a heart"): in a group
 * that is the only way to know which member asked. Empty when the session
 * has no chat (a cron turn, the mirror) or chat.db cannot be read.
 */
export function requestReader(config: Config, sessionKey: string): () => string[] {
  let db: ChatDb | null = null;
  let guids: string[] | null = null;
  let contacts: ContactBook | null = null;
  return () => {
    db ??= new ChatDb(config.paths.chat_db);
    contacts ??= new ContactBook(config.contacts, new AddressBook());
    guids ??= chatGuidsForSession(sessionKey, db, contacts);
    const lines = guids.flatMap((guid) =>
      getRecentMessages(db!, guid, Number.MAX_SAFE_INTEGER, SCAN),
    );
    return lines
      .filter((l) => !l.fromMe && !l.isTapback)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .slice(-MESSAGES)
      .map((l) => {
        const who =
          (l.fromHandle && contacts!.displayName(l.fromHandle)) || l.fromHandle || "someone";
        const said = l.text.length > MAX_CHARS ? `${l.text.slice(0, MAX_CHARS)}…` : l.text;
        return `${who}: ${said}`;
      });
  };
}

/**
 * What started this turn, when it was not somebody's message: an event the
 * harness itself wrote (a kitchen wake asking for a household's note to be
 * brought up to date, a morning review) whose firing started the turn now
 * running, for this session. It lasts the whole of that turn, whatever
 * arrives during it: a household member texting mid-sync does not start a new
 * turn, and without the event the rest of the sync's deletions looked
 * unrequested and were refused, leaving the note half edited. The next turn,
 * which that message starts, is not the job's and gets nothing.
 *
 * Null for an event anyone else wrote: the classifier is told this text is
 * the harness's own request, so a reminder the model scheduled must not reach
 * it that way, or the model could write itself a permission.
 */
export function startedBy(
  job: Pick<CronJob, "sessionKey" | "systemEvent" | "harnessWritten"> | null,
  sessionKey: string,
): string | null {
  if (!job?.harnessWritten || job.sessionKey !== sessionKey) return null;
  const event =
    job.systemEvent.length > EVENT_CHARS
      ? `${job.systemEvent.slice(0, EVENT_CHARS)}…`
      : job.systemEvent;
  return `Edmund's own scheduler started this turn for this event (not a new message, and not content on the screen): ${event}`;
}

/**
 * `startedBy` against the real sources: the record the daemon writes as each
 * turn starts (turn.ts), naming the job that started it, and the cron store
 * for that job. The model's tools can add jobs to the cron store
 * (schedule_reminder), but none marks a job harness-written, so the classifier
 * hears why the turn is running from the harness, not the model. A session
 * with host Bash (`model_host_access = "full"`) could edit these files itself,
 * but it could as easily drive the screen without these tools at all.
 */
export function triggerReader(sessionKey: string, dataDir: string): () => string | null {
  let store: CronStore | null = null;
  return () => {
    const turn = readTurn(dataDir, sessionKey);
    if (!turn?.cronJob) return null;
    store ??= new CronStore(dataDir);
    return startedBy(store.get(turn.cronJob), sessionKey);
  };
}
