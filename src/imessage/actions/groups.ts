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
 * The first message is required. IMCore mints the chat on this Mac only, and
 * nobody else sees it until a message goes out, so a create with nothing sent
 * reported success for a group that did not exist on anyone's phone.
 *
 * The message is sent separately, addressed to the chat that was just created,
 * so it goes out through the same send path as everything else and inherits
 * its retry, idempotency and landing checks.
 */
export async function createChat(args: {
  handles: string[];
  name?: string;
  text: string;
}): Promise<{ ok: true; chatGuid: string } | { ok: false; error: string }> {
  let chat: { guid?: string };
  try {
    chat = ((await invoke("createChat", {
      handles: args.handles,
      ...(args.name ? { name: args.name } : {}),
    })) ?? {}) as { guid?: string };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  if (!chat.guid) {
    return { ok: false, error: "chat created but Messages did not return its identifier" };
  }
  const sent = await sendMessage({
    to: chat.guid,
    chatGuid: chat.guid,
    isGroup: args.handles.length > 1,
    text: args.text,
  });
  return sent.ok ? { ok: true, chatGuid: chat.guid } : sent;
}
