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

const MESSAGES = 3;
const SCAN = 30;
const MAX_CHARS = 500;
/** A scheduled event older than this did not start the turn now running. */
const TURN_MS = 20 * 60_000;
const EVENT_CHARS = 800;

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
 * What started this turn, when it was not somebody's message: the scheduled
 * event (a kitchen wake asking for a household's note to be brought up to
 * date, a morning review, a reminder) that fired for this session after its
 * latest message, within the last TURN_MS. Null when the latest thing to
 * happen was a person writing.
 */
export function startedBy(
  job: Pick<CronJob, "systemEvent" | "lastFiredMs"> | null,
  latestMessageMs: number | null,
  now: number,
): string | null {
  const fired = job?.lastFiredMs;
  if (!job || !fired || now - fired > TURN_MS) return null;
  if (latestMessageMs !== null && latestMessageMs > fired) return null;
  const event =
    job.systemEvent.length > EVENT_CHARS
      ? `${job.systemEvent.slice(0, EVENT_CHARS)}…`
      : job.systemEvent;
  return `Edmund's own scheduler started this turn for this event (not a new message, and not content on the screen): ${event}`;
}

/**
 * `startedBy` against the real sources: the daemon's cron store, which marks
 * a job fired before its turn begins, and chat.db for the latest message
 * anybody sent. Both are records the model cannot write to, so the
 * classifier hears why the turn is running from the harness, not the model.
 */
export function triggerReader(
  config: Config,
  sessionKey: string,
  dataDir: string,
  now: () => number = Date.now,
): () => string | null {
  let store: CronStore | null = null;
  let db: ChatDb | null = null;
  let guids: string[] | null = null;
  return () => {
    store ??= new CronStore(dataDir);
    const job = store.lastFired(sessionKey);
    if (!job) return null;
    db ??= new ChatDb(config.paths.chat_db);
    guids ??= chatGuidsForSession(
      sessionKey,
      db,
      new ContactBook(config.contacts, new AddressBook()),
    );
    const latest = guids
      .flatMap((guid) => getRecentMessages(db!, guid, Number.MAX_SAFE_INTEGER, SCAN))
      .filter((l) => !l.fromMe && !l.isTapback)
      .reduce<number | null>(
        (max, l) => (max === null || l.timestampMs > max ? l.timestampMs : max),
        null,
      );
    return startedBy(job, latest, now());
  };
}
