import { z } from "zod";
import {
  type ResolvedMessage,
  findRecentMessageByText,
  resolveMessageGuid,
} from "../../imessage/participants.ts";
import {
  addGroupMember,
  createChat,
  deleteMessage,
  editMessage,
  leaveGroup,
  removeGroupMember,
  renameGroup,
  setGroupPhoto,
  unsendMessage,
} from "../../imessage/send.ts";
import type { SendResult } from "../../imessage/types.ts";
import { isMirrorSession } from "../../sessions/key.ts";
import { isGroupSession } from "../../sessions/key.ts";
import { assertPathSafe } from "../../util/path-safety.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

/**
 * IMCore-bridge "rich" iMessage actions, each behind a per-action whitelist in
 * `config.imessage_actions` (see config.ts). A tool is offered to the model
 * only when (a) the bridge is live — SIP off + `imsg launch` — and (b) its
 * flag is enabled. So an operator who never turns on `manage_members` will
 * find that the model has no `add_group_member` / `leave_group` etc. tools at
 * all; it can't even attempt them.
 *
 * Defaults (in config.ts): self-affecting / reversible actions on
 * (edit/unsend own messages); anything that changes a shared chat or another
 * person off (delete, rename group, group photo, member management, create
 * chat). `effects` / `subject_lines` are folded into `send_message`, not here.
 */

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

async function finish(res: Promise<SendResult> | SendResult, okMsg: string, what: string) {
  const r = await res;
  if (!r.ok) {
    console.error(`[imessage-action] ${what} FAILED: ${r.error}`);
    return err(`${what} error: ${r.error}`);
  }
  return ok(okMsg);
}

/** Group sessions resolve to exactly one chat guid. Returns it or null. */
function groupChatGuid(ctx: ToolContext): string | null {
  if (!isGroupSession(ctx.sessionKey)) return null;
  return ctx.chatGuids[0] ?? null;
}

const FindOrGuid = {
  find: z
    .string()
    .optional()
    .describe(
      "A snippet of the target message's text — the most recent message containing it is used.",
    ),
  msg_guid: z
    .string()
    .optional()
    .describe("Exact msg_guid (e.g. from search_history). Takes precedence over `find`."),
};

function resolveTarget(
  ctx: ToolContext,
  args: { find?: string; msg_guid?: string },
  requireFromMe: boolean,
): ResolvedMessage | { error: string } {
  if (args.msg_guid?.trim()) {
    const hit = resolveMessageGuid(ctx.chatDb, args.msg_guid);
    if (!hit) return { error: `no message with guid ${args.msg_guid}` };
    if (requireFromMe && !hit.fromMe) return { error: "that message isn't one of yours" };
    return hit;
  }
  if (args.find?.trim()) {
    const hit = findRecentMessageByText(ctx.chatDb, ctx.chatGuids, args.find, { requireFromMe });
    if (!hit)
      return {
        error: requireFromMe
          ? `couldn't find a recent message of yours containing "${args.find}"`
          : `couldn't find a recent message containing "${args.find}"`,
      };
    return hit;
  }
  return { error: "give either `find` (a text snippet) or `msg_guid`" };
}

export function imessageActionTools(ctx: ToolContext): ToolDef[] {
  if (isMirrorSession(ctx.sessionKey)) return [];
  // These used to be withheld when the bridge looked down, which meant a probe
  // that lied — and it did — silently removed the model's ability to edit or
  // react at all. There is one surface now, and an action that cannot be
  // performed says so, which the model can relay. Availability stays a matter of
  // the config whitelist below.
  const cfg = ctx.config.imessage_actions;
  const tools: ToolDef[] = [];

  if (cfg.edit_messages) {
    tools.push({
      name: "edit_message",
      description:
        "Edit one of YOUR OWN already-sent messages in this chat (iMessage allows edits for ~15 minutes). Use to fix a typo or reword something you just sent — far better than sending a '*correction'. Identify the message by `find` (a snippet of its text) or `msg_guid`.",
      inputSchema: z.object({
        ...FindOrGuid,
        new_text: z.string().min(1).describe("The replacement text."),
      }),
      handler: async (args) => {
        const t = resolveTarget(ctx, args, true);
        if ("error" in t) return err(t.error);
        console.log(`[edit_message] ${ctx.sessionKey} msg=${t.messageGuid}`);
        return finish(
          editMessage({ chatGuid: t.chatGuid, messageGuid: t.messageGuid, newText: args.new_text }),
          "edited",
          "edit_message",
        );
      },
    });
  }

  if (cfg.unsend_messages) {
    tools.push({
      name: "unsend_message",
      description:
        "Retract (unsend) one of YOUR OWN recently-sent messages in this chat (iMessage allows this for ~2 minutes). Use when you sent something by mistake or thought better of it. Identify it by `find` (a text snippet) or `msg_guid`. The recipients see 'You unsent a message'.",
      inputSchema: z.object(FindOrGuid),
      handler: async (args) => {
        const t = resolveTarget(ctx, args, true);
        if ("error" in t) return err(t.error);
        console.log(`[unsend_message] ${ctx.sessionKey} msg=${t.messageGuid}`);
        return finish(
          unsendMessage({ chatGuid: t.chatGuid, messageGuid: t.messageGuid }),
          "unsent",
          "unsend_message",
        );
      },
    });
  }

  if (cfg.delete_messages) {
    tools.push({
      name: "delete_message",
      description:
        "Delete a message from the LOCAL Messages history on this Mac (does NOT unsend it for others — use unsend_message for that). Rarely needed; identify by `find` or `msg_guid`.",
      inputSchema: z.object(FindOrGuid),
      handler: async (args) => {
        const t = resolveTarget(ctx, args, false);
        if ("error" in t) return err(t.error);
        console.log(`[delete_message] ${ctx.sessionKey} msg=${t.messageGuid}`);
        return finish(
          deleteMessage({ chatGuid: t.chatGuid, messageGuid: t.messageGuid }),
          "deleted locally",
          "delete_message",
        );
      },
    });
  }

  if (cfg.rename_group) {
    tools.push({
      name: "rename_group",
      description:
        "Rename THIS group chat — the new name is visible to everyone in it. Only works in a group conversation.",
      inputSchema: z.object({ name: z.string().min(1).describe("New group display name.") }),
      handler: async (args) => {
        const g = groupChatGuid(ctx);
        if (!g) return err("not a group chat");
        console.log(`[rename_group] ${ctx.sessionKey} → "${args.name}"`);
        return finish(
          renameGroup({ chatGuid: g, name: args.name }),
          `renamed group to "${args.name}"`,
          "rename_group",
        );
      },
    });
  }

  if (cfg.group_photo) {
    tools.push({
      name: "set_group_photo",
      description:
        "Set (or clear) THIS group chat's photo — visible to everyone. Pass an absolute `image_path` to set it, or `clear: true` to remove it. Only works in a group conversation. (Generate an image first with the image tools if you want a custom one.)",
      inputSchema: z.object({
        image_path: z.string().optional().describe("Absolute path to an image file."),
        clear: z.boolean().optional().describe("Set true to remove the current photo instead."),
      }),
      handler: async (args) => {
        const g = groupChatGuid(ctx);
        if (!g) return err("not a group chat");
        if (!args.clear && !args.image_path) return err("give image_path, or clear: true");
        if (args.image_path) {
          try {
            assertPathSafe(args.image_path);
          } catch (e) {
            return err((e as Error).message);
          }
        }
        console.log(
          `[set_group_photo] ${ctx.sessionKey} ${args.clear ? "clear" : args.image_path}`,
        );
        return finish(
          setGroupPhoto({ chatGuid: g, imagePath: args.clear ? undefined : args.image_path }),
          args.clear ? "cleared group photo" : "set group photo",
          "set_group_photo",
        );
      },
    });
  }

  if (cfg.manage_members) {
    tools.push(
      {
        name: "add_group_member",
        description:
          "Add a participant to THIS group chat by phone number or email. Only works in a group conversation. Double-check the handle — there's no undo besides removing them again.",
        inputSchema: z.object({
          handle: z.string().min(1).describe("Phone number or email to add."),
        }),
        handler: async (args) => {
          const g = groupChatGuid(ctx);
          if (!g) return err("not a group chat");
          console.log(`[add_group_member] ${ctx.sessionKey} +${args.handle}`);
          return finish(
            addGroupMember({ chatGuid: g, handle: args.handle }),
            `added ${args.handle}`,
            "add_group_member",
          );
        },
      },
      {
        name: "remove_group_member",
        description:
          "Remove a participant from THIS group chat by phone number or email. Only works in a group conversation. This is visible to the group — be sure it's what was asked.",
        inputSchema: z.object({
          handle: z.string().min(1).describe("Phone number or email to remove."),
        }),
        handler: async (args) => {
          const g = groupChatGuid(ctx);
          if (!g) return err("not a group chat");
          console.log(`[remove_group_member] ${ctx.sessionKey} -${args.handle}`);
          return finish(
            removeGroupMember({ chatGuid: g, handle: args.handle }),
            `removed ${args.handle}`,
            "remove_group_member",
          );
        },
      },
      {
        name: "leave_group",
        description:
          "Leave THIS group chat (the bot itself exits the conversation). Only works in a group. This is permanent for the bot — it won't see further messages here. Don't do this unless explicitly asked.",
        inputSchema: z.object({}),
        handler: async () => {
          const g = groupChatGuid(ctx);
          if (!g) return err("not a group chat");
          console.log(`[leave_group] ${ctx.sessionKey}`);
          return finish(leaveGroup({ chatGuid: g }), "left the group", "leave_group");
        },
      },
    );
  }

  if (cfg.create_chat) {
    tools.push({
      name: "create_chat",
      description:
        "Start a BRAND-NEW iMessage conversation — a 1:1 if you pass one handle, a group if you pass several — with an optional name and an optional first message. The handles are phone numbers or emails. Use only when explicitly asked to start a new chat with specific people.",
      inputSchema: z.object({
        handles: z
          .array(z.string().min(1))
          .min(1)
          .describe("Phone numbers / emails of participants."),
        name: z
          .string()
          .optional()
          .describe("Group display name (only meaningful with 2+ handles)."),
        text: z.string().optional().describe("Optional first message to send into the new chat."),
      }),
      handler: async (args) => {
        console.log(`[create_chat] ${ctx.sessionKey} → [${args.handles.join(", ")}]`);
        return finish(
          createChat({ handles: args.handles, name: args.name, text: args.text }),
          `created chat with ${args.handles.join(", ")}`,
          "create_chat",
        );
      },
    });
  }

  return tools;
}
