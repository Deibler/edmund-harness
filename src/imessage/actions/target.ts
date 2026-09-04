/** How a send is addressed. */
export interface ChatTarget {
  /** For DMs: phone or Apple ID. For groups: the chat GUID. */
  to: string;
  isGroup: boolean;
  /** Stable chat GUID from chat.db, when the caller has one. */
  chatGuid?: string;
}

/**
 * Which conversation an operation addresses.
 *
 * A GUID read from chat.db is preferred whenever the caller has one: it names
 * one conversation exactly, where a handle can match more than one (the same
 * person over iMessage and SMS, or in several threads).
 *
 * Failing that, groups are already identified by their GUID, and a DM is
 * addressed by the handle itself — IMCore resolves it. The old CLI needed an
 * `any;-;` prefix here, because its attachment path fell through to AppleScript
 * and looked the chat up by exact GUID string. Nothing resolves chats by string
 * match any more, so the prefix is gone with it.
 */
export function chatTarget(target: ChatTarget): string {
  if (target.chatGuid) return target.chatGuid;
  return target.to;
}
