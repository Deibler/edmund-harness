import { z } from "zod";
import { relativeAgo, relay } from "../../bridge/relay.ts";
import { CronStore } from "../../cron/store.ts";
import {
  getChatDisplayName,
  getGroupParticipants,
  groupsForHandle,
} from "../../imessage/participants.ts";
import { chatIdFromKey, isGroupSession } from "../../sessions/key.ts";
import { StateStore } from "../../sessions/store.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

/**
 * Cross-session messaging surface for the model.
 *
 * `list_contacts` — what the model can see (DM contacts, groupchats the
 * caller is in with Edmund).
 * `send_message`  — relay a text to one of those targets. Routes through
 * the recipient's session via cron-fire; see bridge/relay.ts.
 *
 * Design note: tool descriptions intentionally do not mention "the other
 * person also has a bot." From the calling bot's POV this looks like
 * direct contact-to-contact messaging. The relay framing is only visible
 * on the *receiving* side, where the system event makes the relay explicit
 * (otherwise an inbound from a non-session-owner would confuse the bot).
 */

const SendMessageInput = z
  .object({
    message: z.string().min(1).describe("The text to send."),
    additional_context: z
      .string()
      .optional()
      .describe(
        "Optional context for the recipient about *why* you're reaching out — e.g. 'this is about the Saturday plans someone mentioned earlier'. Helpful when the recipient may need framing.",
      ),
    is_group_chat: z
      .boolean()
      .describe(
        "REQUIRED confirmation flag. true = sending to a group chat (must also pass group_chat_id, must NOT pass phone_number). false = sending to a single contact's DM (must also pass phone_number, must NOT pass group_chat_id). The redundancy with phone_number/group_chat_id is intentional — it forces you to be sure which target type you mean before any message goes out.",
      ),
    phone_number: z
      .string()
      .optional()
      .describe(
        "E.164 phone number of the contact, e.g. '+17175551234'. ONLY for DM targets (is_group_chat=false). Must be a number you've already seen in message history (check list_contacts first).",
      ),
    group_chat_id: z
      .string()
      .optional()
      .describe(
        "Stable chat GUID for a group chat (the value list_contacts returns). ONLY for group targets (is_group_chat=true). Must be a group both you and the calling user are in.",
      ),
    media_paths: z
      .array(z.string())
      .max(10)
      .optional()
      .describe(
        "Optional: absolute paths of files to attach — PDFs, images, videos, voice memos, anything iMessage accepts (≤100 MB each, ≤250 MB total, ≤10 files). Each file is COPIED into the recipient's sandbox before delivery; image files surface to the recipient inline (they see the pixels), other files are listed in the recipient's envelope with their staged path so the recipient can `send_attachment` them. Use this for handoff like 'send Sam the trip PDF' — generate or grab the file first, then pass its absolute path here.",
      ),
  })
  .strict();

export function contactsTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "list_contacts",
      description:
        "List the contacts and group chats you can message via send_message. Two sections: (1) DMs — every person who has their own session with the assistant, with name, phone, optional email, and last interaction time; (2) Group chats — only groups where YOU (the calling user) and the assistant are both members, with the group id, name (if any), participant list, and last interaction time. Use this BEFORE calling send_message to find the right phone number or group_chat_id; if a name the user mentioned isn't here, ask the user for the number rather than guessing.",
      inputSchema: z.object({}),
      handler: async () => {
        const text = renderContactList(ctx);
        return { content: [{ type: "text", text }] };
      },
    },
    {
      name: "message_contact",
      description:
        "Reach out to one of your contacts (DM) or post to a group chat you're in. Uses iMessage. The recipient receives it as a normal message and may respond — when they do, their response comes back to you as a regular message you can continue the conversation with. Pick the target type explicitly: is_group_chat=true with group_chat_id for groups, is_group_chat=false with phone_number for DMs. The recipient must already exist in message history; new numbers are not accepted. Use list_contacts first to confirm the right id/number. Note: this is for messaging *other* contacts — for a mid-turn 'on it' heads-up to whoever you are currently talking to, use `send_message` instead. To hand off media along with the message (PDF, image, video, voice memo, etc.) pass absolute paths in `media_paths` — each file is copied into the recipient's sandbox, images surface to them inline, and non-image files are listed for them to forward via `send_attachment`. Caps: ≤10 files, ≤100 MB each, ≤250 MB total.",
      inputSchema: SendMessageInput,
      handler: async (args) => {
        const originatorHandle = chatIdFromKey(ctx.sessionKey);
        const senderIsGroup = isGroupSession(ctx.sessionKey);
        if (senderIsGroup) {
          // From-group relay isn't well-defined: who in the group is the
          // "originator"? Block until we have a real use case.
          return errResp(
            "send_message can only be called from a 1-on-1 DM session, not from a group chat",
          );
        }
        const originatorDisplayName =
          ctx.contacts.displayName(originatorHandle) ?? originatorHandle;

        const inboundDepth = readInboundDepth();

        const result = relay(
          {
            originatorDisplayName,
            originatorHandle,
            message: args.message,
            additionalContext: args.additional_context ?? null,
            isGroupChat: args.is_group_chat,
            phoneNumber: args.phone_number,
            groupChatId: args.group_chat_id,
            inboundDepth,
            mediaPaths: args.media_paths,
          },
          {
            config: ctx.config,
            chatDb: ctx.chatDb,
            contacts: ctx.contacts,
            state: stateStore(ctx),
            crons: ctx.cron instanceof CronStore ? ctx.cron : (ctx.cron as CronStore),
          },
        );
        if (!result.ok) return errResp(result.error);
        return {
          content: [
            {
              type: "text",
              text: `relayed to ${result.targetSessionKey} (depth ${result.envelopeDepth})`,
            },
          ],
        };
      },
    },
  ];
}

/**
 * Format the list_contacts output. Pure-ish (only reads chat.db / state),
 * which keeps the rendering testable separately if needed.
 */
function renderContactList(ctx: ToolContext): string {
  const senderHandle = chatIdFromKey(ctx.sessionKey);
  const senderIsGroup = isGroupSession(ctx.sessionKey);
  const lines: string[] = [];

  // ---- DMs ----
  lines.push("DMs:");
  const state = stateStore(ctx);
  const sessions = state.listSessions().filter((s) => s.isGroup === 0);
  if (sessions.length === 0) {
    lines.push("  (no DM contacts yet)");
  } else {
    for (const s of sessions) {
      const canon = chatIdFromKey(s.sessionKey);
      const aliases = ctx.contacts.aliasesFor(canon);
      const phones = aliases.filter((h) => !h.includes("@"));
      const emails = aliases.filter((h) => h.includes("@"));
      const name = ctx.contacts.displayName(canon) ?? "(no name on file)";
      const last = relativeAgo(Math.max(s.lastInboundMs, s.lastOutboundMs));
      const handlesStr = [phones.join(", "), emails.join(", ")].filter(Boolean).join(" · ");
      lines.push(`  - ${name} — ${handlesStr || canon} — last interaction ${last}`);
    }
  }

  // ---- Group chats ----
  lines.push("");
  lines.push("Group chats (you and the assistant both in):");
  if (senderIsGroup) {
    lines.push(
      "  (you are calling from a group session — list_contacts is intended for the DM scope)",
    );
    return lines.join("\n");
  }

  const callerGroupGuids = new Set(groupsForHandle(ctx.chatDb, senderHandle));
  // Also try canonical aliases of the caller, in case chat.db stored a
  // different handle variant (phone vs Apple ID) than what's in the session key.
  for (const alias of ctx.contacts.aliasesFor(senderHandle)) {
    for (const g of groupsForHandle(ctx.chatDb, alias)) callerGroupGuids.add(g);
  }

  const groupSessions = state.listSessions().filter((s) => s.isGroup === 1);
  const visibleGroups = groupSessions.filter((s) => callerGroupGuids.has(s.chatGuid));
  if (visibleGroups.length === 0) {
    lines.push("  (no shared groups)");
  } else {
    for (const s of visibleGroups) {
      const name = getChatDisplayName(ctx.chatDb, s.chatGuid) ?? "(unnamed)";
      const participants = getGroupParticipants(ctx.chatDb, s.chatGuid).map((h) => {
        const dn = ctx.contacts.displayName(h);
        return dn ? `${dn} (${h})` : h;
      });
      const last = relativeAgo(Math.max(s.lastInboundMs, s.lastOutboundMs));
      lines.push(
        `  - ${s.chatGuid} · ${name} — participants: ${participants.join(", ")} — last interaction ${last}`,
      );
    }
  }
  return lines.join("\n");
}

function readInboundDepth(): number {
  const raw = process.env.EDMUND_INBOUND_DEPTH;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * The tool context exposes the cron store but not the state store — the
 * MCP subprocess needs both. Open state.db read+write here on demand. The
 * underlying `bun:sqlite` connection is cheap to open, and StateStore's
 * constructor is idempotent (mkdirSync + migrate).
 */
function stateStore(ctx: ToolContext): StateStore {
  return new StateStore(ctx.dataDir);
}

function errResp(msg: string) {
  return {
    content: [{ type: "text" as const, text: `error: ${msg}` }],
    isError: true,
  };
}
