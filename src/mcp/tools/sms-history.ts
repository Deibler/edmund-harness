import { formatHistoryLines } from "../../channels/history-format.ts";
import { findTopicShifts } from "../../imessage/segment.ts";
import type { ContactBook } from "../../sessions/contacts.ts";
import { conversationIdFromKey, isSmsSession } from "../../sms/session.ts";
import { SmsStore, type SmsTranscriptMessage } from "../../sms/store.ts";
import type { ToolContext } from "../context.ts";

/**
 * The history tools' answers for an SMS session.
 *
 * chat.db is the iMessage record and has never heard of a Twilio
 * conversation, so every history tool that asked it about an SMS group
 * answered as if the room were empty: on 2026-10-01 a reminder told to
 * "check the thread for pushback first" called get_thread_context on a group
 * text holding 25+ messages and was told "no earlier messages in this chat".
 * The transcript lives in SmsStore; these read it. Same tool names, same
 * output shapes, so the model needs no second vocabulary for the channel.
 */

export type SmsHistory = {
  store: SmsStore;
  /** The store's conversation id: the handle for a DM, the CH sid for a group. */
  conversation: string;
};

const cache = new WeakMap<ToolContext, SmsHistory>();

/** The SMS transcript behind this session, or null when it is not an SMS
 *  session. Opened on first use, like the other on-demand stores here. */
export function smsHistoryFor(ctx: ToolContext): SmsHistory | null {
  if (!isSmsSession(ctx.sessionKey)) return null;
  const hit = cache.get(ctx);
  if (hit) return hit;
  const conversation = conversationIdFromKey(ctx.sessionKey);
  if (!conversation) return null;
  const opened = { store: new SmsStore(ctx.dataDir), conversation };
  cache.set(ctx, opened);
  return opened;
}

export function smsThreadContext(
  sms: SmsHistory,
  contacts: ContactBook,
  args: { beforeMs: number; limit: number; topicShiftMinutes: number },
): string {
  const lines = sms.store.linesBefore(sms.conversation, args.beforeMs, args.limit);
  if (lines.length === 0) return "no earlier messages in this chat";
  const shifts = findTopicShifts(
    { lines, startMs: lines[0]!.timestampMs, endMs: lines[lines.length - 1]!.timestampMs },
    args.topicShiftMinutes * 60_000,
  );
  const rendered = formatHistoryLines(lines, contacts, shifts);
  const more = sms.store.countBefore(sms.conversation, lines[0]!.timestampMs);
  const tail =
    more > 0
      ? `\n\n(${more} earlier message${more === 1 ? "" : "s"} exist; call again with before_time=${new Date(lines[0]!.timestampMs).toISOString()} to page back further)`
      : "";
  return `${rendered.join("\n")}${tail}`;
}

/** Anchor for `before_msg_guid`: the message's own time, or undefined when
 *  the guid is not in this conversation. */
export function smsGuidToTimestamp(sms: SmsHistory, guid: string): number | undefined {
  return sms.store.messageByGuid(sms.conversation, guid)?.timestampMs;
}

export function smsSearch(
  sms: SmsHistory,
  contacts: ContactBook,
  args: { query?: string; sender?: string; since?: number; until?: number; limit: number },
): string {
  const hits = sms.store.search(sms.conversation, {
    query: args.query,
    sender: args.sender,
    sinceMs: args.since,
    untilMs: args.until,
    limit: args.limit,
  });
  // The whole transcript is searched (it is pruned at 90 days), so an empty
  // result is a real "not said here", not "didn't look".
  if (hits.length === 0) return "no matches (searched the full SMS transcript)";
  return hits
    .map((h) => {
      const text = h.text.length > 200 ? `${h.text.slice(0, 200)}…` : h.text;
      return `${h.guid}  ${new Date(h.timestampMs).toISOString()}  ${who(h, contacts)}: ${text}`;
    })
    .join("\n");
}

export function smsGetMessage(sms: SmsHistory, contacts: ContactBook, guid: string): string {
  const m = sms.store.messageByGuid(sms.conversation, guid);
  if (!m) return `not found: ${guid}`;
  return `${new Date(m.timestampMs).toISOString()}  ${who(m, contacts)}\n\n${m.text || "(no text)"}`;
}

/**
 * catch_me_up over SMS returns the transcript itself rather than a Haiku
 * recap: the sub-worker reads chat.db and looks at images, and an SMS thread
 * has neither. Plain text since `sinceMs` is the whole picture.
 */
export function smsCatchUp(
  sms: SmsHistory,
  contacts: ContactBook,
  args: { sinceMs: number; maxMessages: number },
): string {
  const lines = sms.store
    .linesBefore(sms.conversation, Number.MAX_SAFE_INTEGER, args.maxMessages)
    .filter((l) => l.timestampMs > args.sinceMs);
  if (lines.length === 0) {
    return `nothing new in this SMS thread since ${new Date(args.sinceMs).toISOString()}`;
  }
  return [
    `(SMS transcript since ${new Date(args.sinceMs).toISOString()}: ${lines.length} msg${lines.length === 1 ? "" : "s"}. Media over SMS is not downloaded, so there are no images to look at.)`,
    "",
    ...formatHistoryLines(lines, contacts),
  ].join("\n");
}

export const SMS_NO_ATTACHMENTS =
  "no attachments: media sent over SMS is not downloaded yet. The transcript marks where one arrived ('[attachment received …]'), so ask the person to describe it or send it over iMessage.";

function who(m: SmsTranscriptMessage, contacts: ContactBook): string {
  return m.fromMe ? "You" : (contacts.label(m.fromHandle) ?? m.fromHandle);
}
