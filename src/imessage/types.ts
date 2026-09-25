export type InboundMessage = {
  rowId: number;
  /** message GUID — stable across devices, used for echo cache + reply_to */
  msgGuid: string;
  /** chat.db chat_identifier — phone/email for DMs, "chat<id>" for groups */
  chatIdentifier: string;
  /** stable chat GUID — our session anchor */
  chatGuid: string;
  /** true if group chat */
  isGroup: boolean;
  /** sender handle (phone or Apple ID) */
  fromHandle: string;
  /** true if WE sent it (our own outbound — must be ignored) */
  fromMe: boolean;
  /** the message text, normalized */
  text: string;
  /** Apple-epoch nanoseconds converted to unix ms */
  timestampMs: number;
  /** attachment file paths (absolute) */
  attachments: string[];
  /** Apple's on-device transcript for audio attachments, keyed by file path. */
  attachmentTranscripts: Record<string, string>;
  /** service — "iMessage" or "SMS" */
  service: string;
  /** If this is a threaded reply or quote, the parent message's GUID. */
  replyToGuid: string | null;
  /** Set when a group message that doesn't name the assistant was let in
   *  because Jev judged it to be for him (see gating/address-check.ts). */
  unnamedWake?: UnnamedWake;
};

/** Why an un-named group message was let in, and Jev's probabilities. */
export type UnnamedWake = {
  reason: "reply-to-assistant" | "after-assistant" | "name-like";
  /** P(the message is said to the assistant). */
  addressed: number;
  /** P(the sender wants the assistant to reply or act). */
  wantsReply: number;
  /** For a message soon after he spoke: its place in the run of wakes since
   *  someone last named him or swipe-replied to him (1 = the first). */
  streak?: number;
};

/** Hydrated parent-of-reply context: the message that a new inbound replies to. */
export type ReplyContext = {
  msgGuid: string;
  text: string;
  fromHandle: string;
  fromMe: boolean;
  timestampMs: number;
  /** Original chat.db attachment paths (may be volatile). */
  attachments: string[];
};

export type SendResult = { ok: true } | { ok: false; error: string };
