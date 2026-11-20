import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type PendingOrigin,
  type PendingTask,
  PendingTasks,
  newReplyId,
} from "../../grok/pending.ts";
import { type GrokBot, postToBot, webhookPayload } from "../../grok/webhook.ts";
import { getGroupParticipants } from "../../imessage/participants.ts";
import { chatIdFromKey, dmKeyFor } from "../../sessions/key.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef, ToolResult } from "./types.ts";

/**
 * `grokbot_task`: Edmund hands a task to one of the owner's Grok Bots.
 *
 * A Grok Bot is xAI's always-on cloud agent. Each one is a routine with a webhook
 * trigger; this tool POSTs the task to it and the Bot reports back by calling
 * `report_to_edmund` on the Edmund connector, which wakes Edmund here with the
 * result (src/grok/channel.ts). A 200 only means the run started.
 *
 * It spends the owner's Grok usage, so it is registered only where the owner is
 * present: their own DM session, and an iMessage group chat they are a member of
 * (so Edmund can hand a Bot a task from a group the owner asked in). Not a
 * contact's DM, not a group without the owner, not a guest's, not a sub-agent's,
 * and not at all unless the Grok channel is on. The session it was asked from is
 * recorded with the task, so the Bot's report wakes Edmund in that same chat.
 * Webhook URLs and keys live in config.toml and never appear in a result or a log
 * line.
 */

/** How long wait_for_result blocks the turn. A longer job arrives as a message. */
export const MAX_WAIT_MS = 120_000;
const POLL_MS = 1_500;
const MAX_TASK_CHARS = 8_000;

const GrokBotInput = z.object({
  task: z
    .string()
    .min(1)
    .max(MAX_TASK_CHARS)
    .describe(
      "The job for the Grok Bot, written so it can do it with no other context: what to do, what you need back, and any limits. Not secrets.",
    ),
  bot: z
    .string()
    .optional()
    .describe(
      "Which of the owner's Grok Bots, by the name in config.toml. Leave out when there is only one.",
    ),
  wait_for_result: z
    .boolean()
    .optional()
    .describe(
      "Wait here (up to two minutes) for the Bot's result instead of ending your turn. Default false: the result comes back later as its own message from the Grok Bot. Wait only for something quick; it holds up the conversation.",
    ),
});

const text = (body: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError: true } : {}),
});

export type GrokBotDeps = {
  fetchImpl?: typeof fetch;
  /** Replaced in tests so a wait does not take real seconds. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxWaitMs?: number;
  pollMs?: number;
};

/**
 * The owner as the tool's text names them: the first name in `[owner].name`
 * (the source the system prompt's `{{owner}}` reads), or "the owner" when it
 * is not set. Read from config so no deployment's name is written into the
 * source.
 */
export function ownerName(ctx: ToolContext): string {
  return ctx.config.owner?.name?.trim().split(/\s+/)[0] || "the owner";
}

function sentenceStart(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Is this the owner's own DM session? Compared on the canonical handle. */
export function isOwnersDm(ctx: ToolContext): boolean {
  const handle = ctx.config.grok.handle;
  if (!handle) return false;
  return ctx.sessionKey === dmKeyFor(ctx.contacts.canon(handle));
}

const GROUP_PREFIX = "imessage:group:";

/** Is the owner a member of this session's group chat? Read from chat.db as of
 *  now, on the canonical handle (a phone and an email for one person match).
 *  Fails closed: no handle, no chat.db, no such chat, or an error is "no". */
export function ownerInGroup(ctx: ToolContext): boolean {
  const handle = ctx.config.grok.handle;
  if (!handle || !ctx.sessionKey.startsWith(GROUP_PREFIX) || !ctx.chatDb) return false;
  // For a group, `chatGuids` is exactly this one guid; the key says it too.
  const chatGuid = ctx.chatGuids[0] ?? chatIdFromKey(ctx.sessionKey);
  const owner = ctx.contacts.canon(handle);
  try {
    return getGroupParticipants(ctx.chatDb, chatGuid).some((p) => ctx.contacts.canon(p) === owner);
  } catch {
    return false;
  }
}

/**
 * Where this session may use the tool, as the origin to record: the owner's own
 * DM (operator tier), or an iMessage group the owner is in. Null everywhere else.
 *
 * A group has no single sender inside a tool process, so a group session runs at
 * the group tier ([security].contact_tier, "contact" by default; see
 * tierForSessionKey) whoever is in it; the owner's presence is what admits it,
 * not the tier. Guest tiers never reach a group, and are refused here anyway.
 */
export function originFor(ctx: ToolContext): PendingOrigin | null {
  if (ctx.guestTier != null) return null;
  if (isOwnersDm(ctx)) {
    return ctx.sessionTier === "operator"
      ? { sessionKey: ctx.sessionKey, chatGuid: ctx.chatGuids[0] ?? "", isGroup: false }
      : null;
  }
  if (ctx.sessionTier !== "operator" && ctx.sessionTier !== "contact") return null;
  if (!ownerInGroup(ctx)) return null;
  return {
    sessionKey: ctx.sessionKey,
    chatGuid: ctx.chatGuids[0] ?? chatIdFromKey(ctx.sessionKey),
    isGroup: true,
  };
}

export function grokBotTools(ctx: ToolContext, deps: GrokBotDeps = {}): ToolDef[] {
  const grok = ctx.config.grok;
  if (!grok.enabled) return [];
  if (!originFor(ctx)) return [];

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  const owner = ownerName(ctx);

  return [
    {
      name: "grokbot_task",
      description: [
        `Hand a task to one of ${owner}'s Grok Bots (xAI's always-on cloud agents) and let it work in the background. It spends ${owner}'s Grok usage, so use it when a Bot is the right worker (long browsing or research, watching something, anything ${owner} asked a Bot to do), not for what you can do yourself. In a group chat, only when ${owner} asks for it there; no one else in the room can spend ${owner}'s Grok usage.`,
        "The Bot starts at once and reports back on its own: when it finishes, a message 'Grok Bot finished task <reply_id>' arrives in this same chat with the result, and you pass on what matters to whoever asked. Returns the reply_id.",
        "Do not poll; end your turn after saying it is under way. With wait_for_result the call blocks up to two minutes for a quick job. Several Bots may be configured: pass `bot` by name when it matters.",
      ].join(" "),
      inputSchema: GrokBotInput,
      handler: async (args) => {
        const bots = grok.bots;
        const names = Object.keys(bots);
        if (names.length === 0) return text(setupHelp(ctx), true);

        let name: string;
        if (args.bot) {
          const wanted = names.find((n) => n.toLowerCase() === args.bot?.trim().toLowerCase());
          if (!wanted)
            return text(
              `No Grok Bot named "${args.bot}". Configured bots: ${names.join(", ")}.`,
              true,
            );
          name = wanted;
        } else if (names.length === 1) {
          name = names[0] as string;
        } else if (names.includes("default")) {
          name = "default";
        } else {
          return text(
            `More than one Grok Bot is configured; say which one with \`bot\`: ${names.join(", ")}.`,
            true,
          );
        }
        const bot = bots[name] as GrokBot;

        // The owner may have left the group since this process started: the
        // check is made again, now, against chat.db.
        const origin = originFor(ctx);
        if (!origin)
          return text(
            `${sentenceStart(owner)} is not in this chat, so ${owner}'s Grok Bots are not available here.`,
            true,
          );

        const pending = new PendingTasks(ctx.dataDir, now);
        const replyId = newReplyId();
        const wait = args.wait_for_result === true;
        // Recorded BEFORE the post: a Bot can answer within seconds, and the
        // callback must find the id waiting.
        pending.add({ replyId, task: args.task, bot: name, waitMs: wait ? maxWaitMs : 0, origin });

        const sent = await postToBot(bot, name, webhookPayload(args.task, replyId), {
          fetchImpl: deps.fetchImpl,
        });
        if (!sent.ok) {
          pending.cancel(replyId);
          return text(sent.error, true);
        }

        if (!wait) {
          return text(
            `Grok Bot accepted it (bot "${name}", reply_id ${replyId}). It is running now. When it finishes, its result arrives in this chat as a message "Grok Bot finished task ${replyId}". Say it is under way and end your turn.`,
          );
        }

        const deadline = now() + maxWaitMs;
        while (now() < deadline) {
          const found = pending.lookup(replyId);
          if (found.status === "reported") return text(resultText(replyId, name, found.task));
          await sleep(pollMs);
        }
        // Give up waiting, then look once more: a report that landed in the gap
        // is returned here rather than lost.
        pending.stopWaiting(replyId);
        const last = pending.lookup(replyId);
        if (last.status === "reported") return text(resultText(replyId, name, last.task));
        return text(
          `Grok Bot accepted it (bot "${name}", reply_id ${replyId}) but has not finished after ${Math.round(maxWaitMs / 1000)} seconds. Its result will arrive in this chat later as a message "Grok Bot finished task ${replyId}". Say it is still running and end your turn.`,
        );
      },
    },
  ];
}

function resultText(replyId: string, bot: string, task: PendingTask): string {
  // The report may have come in on another bot's own connector key: accepted,
  // but said so (src/grok/caller.ts, mismatchNote).
  const other = task.reportedBy && task.reportedBy !== bot ? task.reportedBy : null;
  const note = other
    ? `Mismatch: this task was sent to bot "${bot}", but the report arrived on bot "${other}"'s own connector key. It was accepted anyway. Treat who actually did the work as uncertain.\n\n`
    : "";
  return `Grok Bot "${bot}" finished task ${replyId}. ${note}Result:\n\n${task.result ?? ""}`;
}

/** What the owner has to do when no bot is configured. No URL, no key. */
function setupHelp(ctx: ToolContext): string {
  const setup = join(ctx.sandboxPath, "grok", "setup.md");
  const owner = ownerName(ctx);
  return [
    `No Grok Bot is set up, so there is nothing to hand the task to. ${sentenceStart(owner)} has to do this once:`,
    `1. In Grok, create a routine for ${owner}'s Bot with a Webhook trigger, and paste in the routine instruction from docs/grok-channel.md (section "Set up a Grok Bot routine for Edmund").`,
    "2. Add the Edmund connector to that Bot's Plugins/connectors, so it can call report_to_edmund.",
    "3. Copy the routine's webhook URL and key into config.toml as [grok.bots.<name>] with webhook_url and key (the file is gitignored), then restart Edmund.",
    existsSync(setup) ? `The same steps, paste-ready, are in ${setup}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
