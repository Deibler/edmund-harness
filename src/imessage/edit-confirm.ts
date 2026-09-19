import type { ChatDb } from "./db.ts";
import { decodeMessageText } from "./decode.ts";

/**
 * Confirms an edit or an unsend against chat.db instead of trusting the bridge.
 *
 * The bridge's edit and retract calls hand the request to imagent over a
 * one-way XPC message, so "accepted" means the request was well formed on the
 * app side and nothing more. On macOS 26 an edit whose compatibility text is
 * of the wrong class is dropped inside imagent during decoding: Messages logs
 * it, the app-side call returns normally, and the tool reported "edited" for
 * a bubble that never changed (2026-09-19). chat.db is the system of record.
 * An edit lands there as the new body plus a `date_edited` stamp; an unsend
 * lands as a `date_edited` stamp with the body cleared (`date_retracted` has
 * never been set on a machine this ran on, and is honored in case a release
 * starts using it).
 */
export interface MessageState {
  text: string;
  dateEdited: number;
  dateRetracted: number;
}

const STATE_SQL = `
  SELECT m.text AS text, m.attributedBody AS body,
         COALESCE(m.date_edited, 0) AS date_edited,
         COALESCE(m.date_retracted, 0) AS date_retracted
  FROM message m
  WHERE m.guid = ? LIMIT 1
`;

export function messageState(chatDb: ChatDb, messageGuid: string): MessageState | null {
  const row = chatDb
    .query<{
      text: string | null;
      body: Uint8Array | null;
      date_edited: number;
      date_retracted: number;
    }>(STATE_SQL)
    .get(messageGuid);
  if (!row) return null;
  return {
    text: decodeMessageText(row.text, row.body),
    dateEdited: row.date_edited,
    dateRetracted: row.date_retracted,
  };
}

export interface ConfirmOptions {
  /** How long to wait for chat.db to reflect the change. */
  timeoutMs?: number;
  /** Poll interval. */
  intervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_MS = 200;
const NOTHING_BEFORE: MessageState = { text: "", dateEdited: 0, dateRetracted: 0 };

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Polls the row until `settled` holds or the timeout passes. Returns the last
 * state read, or null when the row is gone.
 */
async function waitForRow(
  chatDb: ChatDb,
  messageGuid: string,
  settled: (state: MessageState) => boolean,
  opts: ConfirmOptions,
): Promise<MessageState | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  for (;;) {
    const state = messageState(chatDb, messageGuid);
    if (state && settled(state)) return state;
    if (Date.now() >= deadline) return state;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function seconds(opts: ConfirmOptions): string {
  return `${Math.max(1, Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000))}s`;
}

/**
 * Null once chat.db shows the edit; otherwise a sentence for the model that
 * names the outcome rather than the request. An edit counts when the stored
 * text reads as `newText`, or when the edit stamp advanced and a body is still
 * there (Messages may normalize the text it stores). A stamp with the body
 * cleared is an unsend, not this edit.
 */
export async function confirmEdited(
  chatDb: ChatDb,
  messageGuid: string,
  newText: string,
  before: MessageState | null,
  opts: ConfirmOptions = {},
): Promise<string | null> {
  const base = before ?? NOTHING_BEFORE;
  const want = normalize(newText);
  const edited = (s: MessageState) =>
    normalize(s.text) === want || (s.dateEdited > base.dateEdited && s.text.length > 0);
  const after = await waitForRow(chatDb, messageGuid, edited, opts);
  if (!after) return "the message is no longer in chat.db, so the edit cannot be confirmed";
  if (edited(after)) return null;
  return `Messages accepted the edit but chat.db still shows the original text after ${seconds(opts)}, so the bubble did not change; send the correction as a new message instead`;
}

/**
 * Null once chat.db shows the retraction; otherwise a sentence for the model.
 * A row that vanished is treated as retracted: nothing is left to show.
 */
export async function confirmUnsent(
  chatDb: ChatDb,
  messageGuid: string,
  before: MessageState | null,
  opts: ConfirmOptions = {},
): Promise<string | null> {
  const base = before ?? NOTHING_BEFORE;
  const retracted = (s: MessageState) =>
    s.dateRetracted > base.dateRetracted || (s.dateEdited > base.dateEdited && s.text.length === 0);
  const after = await waitForRow(chatDb, messageGuid, retracted, opts);
  if (!after || retracted(after)) return null;
  return `Messages accepted the unsend but chat.db still shows the message after ${seconds(opts)}, so it was not retracted and the recipient can still see it`;
}
