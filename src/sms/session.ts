import { normalizeHandle } from "../sessions/key.ts";

/**
 * SMS session identity — DMs and group texts.
 *
 * ## Two identities, and why routing needs no decision
 *
 * Edmund reaches people two ways: his iMessage address
 * (`bot@example.com`) and his Twilio number. Which one a room uses is
 * decided by the room, not by us:
 *
 *   | room                     | address        | inbound arrives via |
 *   |--------------------------|----------------|---------------------|
 *   | DM over iMessage         | email          | chat.db watcher     |
 *   | group, all iMessage      | email          | chat.db watcher     |
 *   | DM over SMS              | Twilio number  | Twilio webhook      |
 *   | group with any SMS member| Twilio number  | Twilio webhook      |
 *
 * A message physically arrives on exactly one of those transports, so the
 * arrival path IS the router. Nothing has to choose, which means nothing can
 * choose wrong. An all-iMessage group keeps working exactly as it does today
 * and never touches this module.
 *
 * ## Why a separate namespace
 *
 *  1. **History would silently be empty.** `buildHistoryBundle` reads chat.db
 *     by chatGuid, and chat.db has never heard of a Twilio conversation.
 *     Sharing the `imessage:` namespace would render a blank history rather
 *     than an error — a structural zero that looks like a quiet thread.
 *  2. **The channels differ in kind.** No tapbacks, no effects, no typing
 *     indicators, a hard per-segment cost, and a regulatory opt-out regime.
 *
 * ## Group keys are Conversation SIDs, not participant sets
 *
 * A group is keyed by Twilio's Conversation SID (`CH…`), never by a hash of
 * its members. Membership changes — someone is added, someone leaves — and a
 * membership-derived key would fork the room's history at that moment while
 * Twilio considers it the same conversation.
 */

export const SMS_DM_PREFIX = "sms:dm:";
export const SMS_GROUP_PREFIX = "sms:group:";

/** `sms:dm:+17175550123` — a one-to-one SMS conversation. */
export function smsKeyFor(handle: string): string {
  return `${SMS_DM_PREFIX}${normalizeHandle(handle)}`;
}

/** `sms:group:CH…` — a group MMS conversation. */
export function smsGroupKeyFor(conversationSid: string): string {
  return `${SMS_GROUP_PREFIX}${conversationSid}`;
}

export function isSmsSession(key: string): boolean {
  return key.startsWith(SMS_DM_PREFIX) || key.startsWith(SMS_GROUP_PREFIX);
}

export function isSmsGroupSession(key: string): boolean {
  return key.startsWith(SMS_GROUP_PREFIX);
}

/** The phone number behind a DM session key, or null (groups have no single handle). */
export function smsHandleFromKey(key: string): string | null {
  return key.startsWith(SMS_DM_PREFIX) ? key.slice(SMS_DM_PREFIX.length) : null;
}

/** The Twilio Conversation SID behind a group session key, or null. */
export function smsConversationFromKey(key: string): string | null {
  return key.startsWith(SMS_GROUP_PREFIX) ? key.slice(SMS_GROUP_PREFIX.length) : null;
}

/**
 * The store/transcript key for a conversation: the normalized handle for a
 * DM, the Conversation SID for a group. One column, one lookup, both shapes.
 */
export function conversationIdFromKey(key: string): string | null {
  return smsHandleFromKey(key) ?? smsConversationFromKey(key);
}

/**
 * Synthetic chat GUID, prefixed so it can never collide with a real chat.db
 * GUID (`iMessage;-;+1…` / `SMS;+;chat123…`). Anything that mistakenly hands
 * one of these to a chat.db query gets zero rows rather than a stranger's
 * conversation.
 */
export function smsChatGuidFor(conversationId: string): string {
  return `sms:${conversationId}`;
}

export function isSmsChatGuid(guid: string): boolean {
  return guid.startsWith("sms:");
}
