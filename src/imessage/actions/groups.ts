import { invoke } from "../bridge/index.ts";
import type { SendResult } from "../types.ts";
import { describeError } from "./classify.ts";
import { asSendResult } from "./result.ts";
import { sendMessage } from "./send.ts";

/**
 * Group membership and naming.
 *
 * Each of these returns void inside IMCore, so the call returning has never been
 * evidence it took effect. imcore-bridge reads the group back afterwards and
 * reports `changed`, and asks `canAddParticipants:` / `canRemoveParticipants:`
 * before a membership change rather than reporting a success that did nothing —
 * the common case being a removal that would leave a group of two, which IMCore
 * declines silently. A refusal is surfaced here as an error, with its reason.
 */
type GroupOutcome = { changed?: boolean; reason?: string };

/** Turns "IMCore did nothing, and said why" into a failure the caller can see. */
async function asGroupResult(run: () => Promise<unknown>): Promise<SendResult> {
  try {
    const outcome = (await run()) as GroupOutcome | null;
    if (outcome && outcome.changed === false) {
      return { ok: false, error: outcome.reason ?? "Messages declined the change" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export function renameGroup(args: { chatGuid: string; name: string }): Promise<SendResult> {
  return asGroupResult(() => invoke("groupRename", { chat: args.chatGuid, name: args.name }));
}

/** Set a group's photo, or clear it by omitting the path. */
export function setGroupPhoto(args: {
  chatGuid: string;
  imagePath?: string;
}): Promise<SendResult> {
  return asSendResult(() =>
    invoke("groupPhoto", {
      chat: args.chatGuid,
      ...(args.imagePath ? { file: args.imagePath } : {}),
    }),
  );
}

export function addGroupMember(args: { chatGuid: string; handle: string }): Promise<SendResult> {
  return asGroupResult(() =>
    invoke("groupAddMembers", { chat: args.chatGuid, members: [args.handle] }),
  );
}

export function removeGroupMember(args: { chatGuid: string; handle: string }): Promise<SendResult> {
  return asGroupResult(() =>
    invoke("groupRemoveMembers", { chat: args.chatGuid, members: [args.handle] }),
  );
}

/** Leave a group. Only someone still in it can add us back. */
export function leaveGroup(args: { chatGuid: string }): Promise<SendResult> {
  return asGroupResult(() => invoke("groupLeave", { chat: args.chatGuid }));
}

/**
 * Start a new conversation — 1:1 with one handle, a group with several.
 *
 * The first message is sent separately, addressed to the chat that was just
 * created, so it goes out through the same send path as everything else and
 * inherits its retry and idempotency behaviour.
 */
export async function createChat(args: {
  handles: string[];
  name?: string;
  text?: string;
}): Promise<SendResult> {
  let chat: { guid?: string };
  try {
    chat = ((await invoke("createChat", {
      handles: args.handles,
      ...(args.name ? { name: args.name } : {}),
    })) ?? {}) as { guid?: string };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  if (!args.text) return { ok: true };
  if (!chat.guid) {
    return { ok: false, error: "chat created but Messages did not return its identifier" };
  }
  return sendMessage({
    to: chat.guid,
    chatGuid: chat.guid,
    isGroup: args.handles.length > 1,
    text: args.text,
  });
}
