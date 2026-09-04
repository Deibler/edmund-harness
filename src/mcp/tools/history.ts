import { z } from "zod";
import { formatHistoryLines } from "../../channels/history-format.ts";
import { runCatchUp } from "../../claude/catch-up.ts";
import { countBefore, getRecentMessages, resolveBeforeRowId } from "../../imessage/history.ts";
import { getMessage, listAttachments, searchMessages } from "../../imessage/search.ts";
import { findTopicShifts } from "../../imessage/segment.ts";
import { persistEpisodicSummary } from "../../memory/summary-writer.ts";
import {
  type VisibilityLine,
  makeHistoryFilter,
  viewerForSession,
} from "../../orchestrators/visibility.ts";
import { StateStore } from "../../sessions/store.ts";
import type { ToolContext } from "../context.ts";
import type { ToolDef } from "./types.ts";

const DateLike = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? v : Date.parse(v)))
  .describe("ISO string or unix ms.");

const SearchInput = z.object({
  query: z.string().optional().describe("Substring to match in message text (case-insensitive)."),
  sender: z.string().optional().describe("Filter to one handle (phone/email). Omit to match any."),
  since: DateLike.optional().describe("Earliest timestamp."),
  until: DateLike.optional().describe("Latest timestamp."),
  limit: z.number().int().positive().max(200).default(50),
});

const GetMessageInput = z.object({
  msg_guid: z.string().describe("Message guid returned from search_history."),
});

const ThreadContextInput = z.object({
  before_time: DateLike.optional().describe(
    "Anchor: fetch messages strictly before this timestamp. Default: now (so 'limit' messages of the most recent history). ISO string or unix ms.",
  ),
  before_msg_guid: z
    .string()
    .optional()
    .describe(
      "Alternative anchor: fetch messages strictly before this msg_guid (from search_history / envelope). Takes precedence over before_time.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(30)
    .describe("How many messages to return. Max 100 per call."),
});

const CatchMeUpInput = z.object({
  since: DateLike.optional().describe(
    "Lower bound: summarize messages strictly after this timestamp. Defaults to your last reply in this chat (or 7 days ago if you've never replied). ISO string or unix ms.",
  ),
  max_messages: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Hard cap on how many messages the summarizer reads. Defaults to 200, max 500."),
});

const ListAttachmentsInput = z.object({
  mime_prefix: z
    .string()
    .optional()
    .describe("Filter by mime prefix, e.g. 'image/' for images, 'audio/' for voice notes."),
  since: DateLike.optional(),
  until: DateLike.optional(),
  sender: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
});

export function historyTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "search_history",
      description:
        "Search prior messages in THIS conversation. Scoped to the current chat (group) or contact's DMs (including alias handles). Returns msg_guid, time, sender, text, and whether the message has attachments. Use when the user references something they said earlier, asks you to recall a past discussion, or needs context you don't have in your working memory.",
      inputSchema: SearchInput,
      handler: (args) => {
        const outcome = searchMessages(ctx.chatDb, {
          chatGuids: ctx.chatGuids,
          query: args.query,
          senderHandle: args.sender,
          sinceMs: args.since,
          untilMs: args.until,
          limit: args.limit,
        });
        const hits = outcome.hits.filter(visibilityFilter(ctx));
        // Honest empty result: say how far back the scan actually looked,
        // so "no matches" can't silently mean "didn't look".
        const depth = outcome.exhausted
          ? "searched the full history window"
          : outcome.scannedToMs
            ? `searched back to ${new Date(outcome.scannedToMs).toISOString().slice(0, 10)} — older messages exist; narrow with since/until to search further`
            : "nothing to search";
        if (hits.length === 0) return textResult(`no matches (${depth})`);
        const lines = hits.map((h) => {
          const who = h.fromMe ? "You" : (ctx.contacts.displayName(h.fromHandle) ?? h.fromHandle);
          const att = h.hasAttachments ? " [attachment]" : "";
          const text = h.text.length > 200 ? `${h.text.slice(0, 200)}…` : h.text;
          return `${h.msgGuid}  ${new Date(h.timestampMs).toISOString()}  ${who}${att}: ${text}`;
        });
        const footer = outcome.exhausted ? [] : [`(${depth})`];
        return textResult([...lines, ...footer].join("\n"));
      },
    },
    {
      name: "get_message",
      description:
        "Fetch the full text and attachment file paths for one message (by msg_guid from search_history). Useful when the search preview was truncated or you need the attachment paths to Read.",
      inputSchema: GetMessageInput,
      handler: (args) => {
        const m = getMessage(ctx.chatDb, args.msg_guid);
        if (!m) return textResult(`not found: ${args.msg_guid}`);
        // Hidden-by-visibility reads identically to absent — don't leak that
        // another orchestrator's message exists at this guid.
        if (!visibilityFilter(ctx)(m)) return textResult(`not found: ${args.msg_guid}`);
        const who = m.fromMe ? "You" : (ctx.contacts.displayName(m.fromHandle) ?? m.fromHandle);
        const attachments = m.attachments
          .map((a) => `  ${a.path}${a.mime ? ` (${a.mime})` : ""}`)
          .join("\n");
        return textResult(
          [
            `${new Date(m.timestampMs).toISOString()}  ${who}`,
            m.text || "(no text)",
            attachments ? `Attachments:\n${attachments}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      },
    },
    {
      name: "get_thread_context",
      description:
        "Scroll-back tool. Returns prior messages in THIS chat in chronological order (oldest → newest), in the same speaker-tagged format the envelope uses ([Name · Day HH:MM] text) — so you can mentally splice the output onto what you already see. Two ways to anchor: `before_time` (most common — get me everything before this moment) or `before_msg_guid` (anchor to a specific message you saw earlier). Defaults to the last 30 messages before now. Use this when the History scope descriptor mentions earlier omitted messages, or when something in the thread references context outside your envelope window. Cheap (pure SQL); call it multiple times to page back further.",
      inputSchema: ThreadContextInput,
      handler: (args) => {
        if (ctx.chatGuids.length === 0) return textResult("no chats in scope");
        // Resolve anchor → an effective rowId. Multi-chat sessions (DMs
        // with several alias handles) take the union: we resolve per-guid
        // and merge, sorting by timestamp and taking the tail `limit`.
        const beforeMs = args.before_msg_guid
          ? guidToTimestamp(ctx, args.before_msg_guid)
          : args.before_time;
        const effectiveMs = beforeMs ?? Date.now();
        const all = ctx.chatGuids
          .flatMap((g) => {
            const anchor = resolveBeforeRowId(ctx.chatDb, g, effectiveMs);
            if (anchor <= 0) return [];
            return getRecentMessages(ctx.chatDb, g, anchor, args.limit);
          })
          .filter(visibilityFilter(ctx));
        // Re-sort merged result chronologically and tail-cap to limit.
        all.sort((a, b) => a.timestampMs - b.timestampMs);
        const lines = all.slice(-args.limit);
        if (lines.length === 0) return textResult("no earlier messages in this chat");

        // Inject the same topic-shift markers the envelope uses so the
        // output looks continuous with what the model already saw.
        const shifts = findTopicShifts(
          { lines, startMs: lines[0]!.timestampMs, endMs: lines[lines.length - 1]!.timestampMs },
          ctx.config.behavior.topic_shift_minutes * 60_000,
        );
        const rendered = formatHistoryLines(lines, ctx.contacts, shifts);

        // Continuation hint: how many messages remain before the oldest in
        // this slice, so the model knows whether another call would yield
        // more.
        const oldestRowId = all.length > 0 ? Math.min(...lines.map((l) => l.rowId)) : 0;
        const moreRemaining = ctx.chatGuids.reduce(
          (sum, g) => sum + countBefore(ctx.chatDb, g, oldestRowId),
          0,
        );
        const tail =
          moreRemaining > 0
            ? `\n\n(${moreRemaining} earlier message${moreRemaining === 1 ? "" : "s"} exist; call again with before_time=${new Date(lines[0]!.timestampMs).toISOString()} to page back further)`
            : "";
        return textResult(`${rendered.join("\n")}${tail}`);
      },
    },
    {
      name: "catch_me_up",
      description:
        "Spawn a fast Haiku sub-worker to read everything in THIS chat since you last spoke (or since `since`), look at any load-bearing images, and return a structured recap (participants, topics, unresolved questions, media highlights, tone). Use this when the History scope tells you there's been a long gap with a lot of activity and the inbound references context you weren't around for. Synchronous — blocks the current turn ~5-15s. DON'T reach for it reflexively: if a direct reply doesn't require knowing what happened in the gap, just answer.",
      inputSchema: CatchMeUpInput,
      handler: async (args) => {
        if (ctx.chatGuids.length === 0) return errResult("no chats in scope");
        const sinceMs = args.since ?? defaultCatchUpSince(ctx);
        const res = await runCatchUp({
          chatDb: ctx.chatDb,
          contacts: ctx.contacts,
          chatGuids: ctx.chatGuids,
          sinceMs,
          maxMessages: args.max_messages,
          lineFilter: visibilityFilter(ctx),
          spend: { dataDir: ctx.dataDir, sessionKey: ctx.sessionKey },
        });
        if (!res.ok) return errResult(res.error);
        // Episodic layer: the recap we just paid for becomes a searchable
        // `summary` row instead of evaporating after this turn.
        if (res.messageCount > 0 && ctx.chatGuids[0]) {
          await persistEpisodicSummary({
            dataDir: ctx.dataDir,
            config: ctx.config,
            chatGuid: ctx.chatGuids[0],
            text: res.summary,
            sinceMs,
            untilMs: Date.now(),
            source: "catch_me_up",
          });
        }
        const meta = `(read ${res.messageCount} msg${res.messageCount === 1 ? "" : "s"}${res.imageCount > 0 ? ` + ${res.imageCount} image${res.imageCount === 1 ? "" : "s"}` : ""} in ${Math.round(res.elapsedMs / 1000)}s)\n\n`;
        return textResult(`${meta}${res.summary}`);
      },
    },
    {
      name: "list_attachments",
      description:
        "List files/images/audio shared in THIS conversation. Filter by mime_prefix (e.g. 'image/'), sender, or date range. Returns absolute paths you can pass to the Read tool. Use when the user asks about a photo they sent, or you want to ground a reply in visual context.",
      inputSchema: ListAttachmentsInput,
      handler: (args) => {
        const visible = visibilityFilter(ctx);
        const hits = listAttachments(ctx.chatDb, {
          chatGuids: ctx.chatGuids,
          senderHandle: args.sender,
          sinceMs: args.since,
          untilMs: args.until,
          mimePrefix: args.mime_prefix,
          limit: args.limit,
          // AttachmentHit carries no text, so ownership resolves via the
          // rowId routing record only; unrouted rows stay visible.
        }).filter((h) => visible({ rowId: h.rowId, fromMe: h.fromMe, text: "" }));
        if (hits.length === 0) return textResult("no attachments");
        const lines = hits.map((h) => {
          const who = h.fromMe ? "You" : (ctx.contacts.displayName(h.fromHandle) ?? h.fromHandle);
          return `${new Date(h.timestampMs).toISOString()}  ${who}  ${h.mimeType || "?"}  ${h.filePath}`;
        });
        return textResult(lines.join("\n"));
      },
    },
  ];
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Resolve a msg_guid → its unix-ms timestamp; falls back to Date.now() if
 *  the guid isn't in scope. The tool's get_thread_context handler uses this
 *  to translate the `before_msg_guid` anchor into a time anchor. */
function guidToTimestamp(ctx: ToolContext, msgGuid: string): number | undefined {
  const m = getMessage(ctx.chatDb, msgGuid);
  return m?.timestampMs;
}

function errResult(msg: string) {
  return { content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true };
}

/**
 * Per-call orchestrator-visibility gate for the history tools. Constant
 * true when no [[orchestrators]] are configured. Opens its own read handle
 * on state.db (same on-demand pattern as defaultCatchUpSince) to resolve
 * inbound routing records and outbound sent-attributions.
 */
function visibilityFilter(ctx: ToolContext): (line: VisibilityLine) => boolean {
  if (ctx.config.orchestrators.length === 0) return () => true;
  let store: StateStore | null = null;
  try {
    store = new StateStore(ctx.dataDir);
  } catch {
    store = null; // text-fallback matching still applies
  }
  return makeHistoryFilter(viewerForSession(ctx.sessionKey), ctx.chatGuids, ctx.config, store);
}

/**
 * Default `since` for catch_me_up: the model's last reply in this session
 * (per state.db), or 7 days ago if it has never replied here. The state
 * store is opened on-demand — same pattern as message_contact's stateStore().
 */
function defaultCatchUpSince(ctx: ToolContext): number {
  try {
    const state = new StateStore(ctx.dataDir);
    const session = state.getSession(ctx.sessionKey);
    if (session && session.lastOutboundMs > 0) return session.lastOutboundMs;
  } catch {
    // State db unavailable — fall through to the 7-day default.
  }
  return Date.now() - 7 * 24 * 3_600_000;
}
