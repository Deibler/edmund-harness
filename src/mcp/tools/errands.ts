import { z } from "zod";
import { relativeAgo, relay } from "../../bridge/relay.ts";
import { ErrandStore, errandAnsweredEvent, errandFollowupEvent } from "../../concierge/errands.ts";
import { chatIdFromKey, isGroupSession } from "../../sessions/key.ts";
import { StateStore } from "../../sessions/store.ts";
import { genId } from "../../util/ids.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

/**
 * Concierge errands — tracked round-trip asks.
 *
 * `ask_contact` is `message_contact` with a contract: the receiving
 * session is told to bring the answer back via `report_errand`, a
 * follow-up cron keeps unanswered asks from dying silently, and the
 * answer lands in the asking session as a system event so the asker's
 * Edmund can close the loop with their user.
 */

const DEFAULT_FOLLOWUP_HOURS = 8;

const AskInput = z
  .object({
    question: z
      .string()
      .min(1)
      .describe(
        "What to ask, written as the message the contact will receive. Keep it the way the user would phrase an ask through a mutual friend.",
      ),
    additional_context: z
      .string()
      .optional()
      .describe("Optional framing for the recipient about why you're asking."),
    is_group_chat: z
      .boolean()
      .describe(
        "true = asking a group chat (pass group_chat_id), false = asking one contact's DM (pass phone_number). Same targeting rules as message_contact.",
      ),
    phone_number: z
      .string()
      .optional()
      .describe("E.164 phone for DM targets. Must appear in list_contacts."),
    group_chat_id: z
      .string()
      .optional()
      .describe("Stable chat GUID for group targets (from list_contacts)."),
    follow_up_after_hours: z
      .number()
      .min(1)
      .max(72)
      .optional()
      .describe(
        `Hours before you get nudged to chase an unanswered ask. Default ${DEFAULT_FOLLOWUP_HOURS}. Match the urgency — 'does Saturday work' for tomorrow deserves a shorter window than a someday question.`,
      ),
  })
  .strict();

const ReportInput = z.object({
  errand_id: z.string().describe("The errand id from the tracked-ask envelope."),
  answer: z
    .string()
    .min(1)
    .describe(
      "The contact's answer, relayed faithfully in a sentence or two. 'They said no' or 'no answer, they're traveling' are valid complete reports.",
    ),
});

const CancelInput = z.object({
  errand_id: z.string().describe("Id of an errand YOU created (see list_errands)."),
});

export function errandTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "ask_contact",
      description:
        "Ask a contact something ON THE USER'S BEHALF and get the ANSWER brought back — the round-trip version of message_contact. Use when the user wants information or a decision from someone ('ask Mom if Saturday works', 'see if Riley wants in on the trip', 'find a time that works for both'): the recipient is asked, their reply is reported back to THIS conversation, and if nothing comes back within the follow-up window you're woken to chase it. For multiple people, call once per contact and reconcile the answers as they land. For one-way messages with no answer expected, use message_contact instead. After asking, tell the user in one line who you asked and that you'll bring back the answer.",
      inputSchema: AskInput,
      handler: async (args) => {
        if (isGroupSession(ctx.sessionKey)) {
          return err(
            "ask_contact can only be called from a 1-on-1 DM session, not from a group chat",
          );
        }
        const originatorHandle = chatIdFromKey(ctx.sessionKey);
        const originatorDisplayName =
          ctx.contacts.displayName(originatorHandle) ?? originatorHandle;

        const errands = new ErrandStore(ctx.dataDir);
        const state = new StateStore(ctx.dataDir);

        // Pre-generate the id so the receiving envelope can reference it;
        // the row is only inserted once the relay actually goes through.
        const pendingId = genId("err");

        const result = relay(
          {
            originatorDisplayName,
            originatorHandle,
            message: args.question,
            additionalContext: args.additional_context ?? null,
            isGroupChat: args.is_group_chat,
            phoneNumber: args.phone_number,
            groupChatId: args.group_chat_id,
            inboundDepth: readInboundDepth(),
            errandId: pendingId,
          },
          {
            config: ctx.config,
            chatDb: ctx.chatDb,
            contacts: ctx.contacts,
            state,
            crons: ctx.cron,
          },
        );
        if (!result.ok) return err(result.error);

        const targetName = args.is_group_chat
          ? (args.group_chat_id ?? "the group")
          : (ctx.contacts.displayName(args.phone_number ?? "") ?? args.phone_number ?? "them");

        const followupHours = args.follow_up_after_hours ?? DEFAULT_FOLLOWUP_HOURS;
        const followup = ctx.cron.create({
          sessionKey: ctx.sessionKey,
          systemEvent: errandFollowupEvent({
            id: pendingId,
            targetName,
            ask: args.question,
          }),
          schedule: { kind: "once", atMs: Date.now() + followupHours * 3_600_000 },
          gracePeriodMs: null,
        });

        errands.create({
          id: pendingId,
          originatorSession: ctx.sessionKey,
          originatorName: originatorDisplayName,
          targetSession: result.targetSessionKey,
          targetName,
          ask: args.question,
          followupCronId: followup.id,
        });

        return ok(
          `errand ${pendingId} sent to ${targetName} — their answer will come back here; follow-up in ${followupHours}h if silent. Tell the user in one line.`,
        );
      },
    },
    {
      name: "report_errand",
      description:
        "Close out a tracked ask (errand) assigned to THIS chat — relay the contact's answer back to whoever asked. Call it the moment your conversation partner gives their answer (or declines, or clearly won't answer). The answer is delivered into the asker's conversation automatically; you don't need to message them separately.",
      inputSchema: ReportInput,
      handler: (args) => {
        const errands = new ErrandStore(ctx.dataDir);
        const errand = errands.get(args.errand_id);
        if (!errand) return err(`no errand ${args.errand_id}`);
        if (errand.targetSession !== ctx.sessionKey) {
          return err("that errand isn't assigned to this chat");
        }
        if (errand.status === "canceled") {
          return ok("that errand was canceled by the asker — no report needed, drop it");
        }
        if (errand.status !== "active") {
          return err(`errand ${args.errand_id} is already ${errand.status}`);
        }
        errands.markAnswered(errand.id, args.answer);
        if (errand.followupCronId) ctx.cron.cancel(errand.followupCronId);
        ctx.cron.create({
          sessionKey: errand.originatorSession,
          systemEvent: errandAnsweredEvent(errand, args.answer),
          schedule: { kind: "once", atMs: Date.now() },
          gracePeriodMs: null,
        });
        return ok(`reported back to ${errand.originatorName} — errand ${errand.id} closed`);
      },
    },
    {
      name: "list_errands",
      description:
        "Show tracked asks touching this conversation: ones you sent (and whether they're answered) and open ones you OWE an answer on. Check before nudging anyone and when a follow-up wakes you.",
      inputSchema: z.object({}),
      handler: () => {
        const errands = new ErrandStore(ctx.dataDir);
        const sent = errands.sentBy(ctx.sessionKey);
        const owed = errands.owedBy(ctx.sessionKey);
        if (sent.length === 0 && owed.length === 0) return ok("no errands");
        const lines: string[] = [];
        if (sent.length > 0) {
          lines.push("Asks you sent:");
          for (const e of sent) {
            const age = relativeAgo(e.createdMs);
            const tail =
              e.status === "answered"
                ? `answered: "${e.answer}"`
                : e.status === "canceled"
                  ? "canceled"
                  : "awaiting answer";
            lines.push(`  • ${e.id} → ${e.targetName} (${age}): "${e.ask}" — ${tail}`);
          }
        }
        if (owed.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push("Open asks you owe an answer on (report_errand when you have it):");
          for (const e of owed) {
            lines.push(
              `  • ${e.id} from ${e.originatorName} (${relativeAgo(e.createdMs)}): "${e.ask}"`,
            );
          }
        }
        return ok(lines.join("\n"));
      },
    },
    {
      name: "cancel_errand",
      description:
        "Cancel a tracked ask you created — the answer no longer matters (plans changed, user got it themselves). The recipient's side is told it's moot if they try to report.",
      inputSchema: CancelInput,
      handler: (args) => {
        const errands = new ErrandStore(ctx.dataDir);
        const errand = errands.get(args.errand_id);
        if (!errand) return err(`no errand ${args.errand_id}`);
        if (errand.originatorSession !== ctx.sessionKey) {
          return err("you can only cancel errands you created");
        }
        if (errand.status !== "active") return err(`errand is already ${errand.status}`);
        errands.markCanceled(errand.id);
        if (errand.followupCronId) ctx.cron.cancel(errand.followupCronId);
        return ok(`canceled errand ${errand.id}`);
      },
    },
  ];
}

/** Same semantics as contacts.ts: relay depth of the inbound that started this turn. */
function readInboundDepth(): number {
  const raw = process.env.EDMUND_INBOUND_DEPTH;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
