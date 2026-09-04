import { invoke } from "../bridge/index.ts";
import type { SendResult } from "../types.ts";
import { asSendResult } from "./result.ts";

/** Edit one of our own already-sent messages, inside iMessage's ~15-min window. */
export function editMessage(args: {
  chatGuid: string;
  messageGuid: string;
  newText: string;
}): Promise<SendResult> {
  return asSendResult(() =>
    invoke("edit", { chat: args.chatGuid, message: args.messageGuid, text: args.newText }),
  );
}

/**
 * Retract one of our own recently-sent messages, inside the ~2-min window.
 *
 * Retraction applies here for certain and on the other side only usually, so a
 * success is "we asked and Messages accepted", not "they never saw it".
 */
export function unsendMessage(args: {
  chatGuid: string;
  messageGuid: string;
}): Promise<SendResult> {
  return asSendResult(() => invoke("retract", { chat: args.chatGuid, message: args.messageGuid }));
}

/** Delete a message from the local history. Destructive, and local only. */
export function deleteMessage(args: {
  chatGuid: string;
  messageGuid: string;
}): Promise<SendResult> {
  return asSendResult(() =>
    invoke("deleteMessages", { chat: args.chatGuid, messages: [args.messageGuid] }),
  );
}
