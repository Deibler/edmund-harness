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
