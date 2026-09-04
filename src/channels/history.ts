import { getRecentMessages } from "../imessage/history.ts";
import { recentReactionsToMe } from "../imessage/reactions.ts";
import { lookupReplyContext } from "../imessage/reply-lookup.ts";
import { findTopicShifts, pickActiveSegment, segmentByGaps } from "../imessage/segment.ts";
import type { InboundMessage, ReplyContext } from "../imessage/types.ts";
import { makeHistoryFilter, viewerForSession } from "../orchestrators/visibility.ts";
import { copyAttachments } from "../persona/copy-received.ts";
import { chatIdFromKey, isSmsSession } from "../sessions/key.ts";
import type { SessionKey } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import type { Deps } from "./deps.ts";
import { formatHistoryLines } from "./history-format.ts";

/**
 * Bundle of derived envelope fields: speaker-tagged history lines, a one-line
 * scope summary, a coarse invocation classification (groups only), and an
 * optional catch-up nudge when the model is far behind in a busy thread.
 */
export type HistoryBundle = {
  /** Pre-formatted, speaker-tagged history lines for the envelope. */
  lines: string[];
  /** One-line scope summary (e.g. "12 msgs over 18m, active thread. You
   *  last replied 6m ago."). Undefined when history is empty. */
  scope: string | undefined;
  /** Invocation classification — only set for groups. */
  invocation: "direct" | "mid_thread" | "passing_reference" | "cold" | undefined;
  /** When set, an attention-grabbing nudge for the envelope: too many
   *  messages have piled up since the model last spoke, recommend
   *  calling `catch_me_up`. */
  catchUpNudge: string | undefined;
};

/**
 * Resolve threaded replies: if the inbound message has `replyToGuid`, fetch
 * the parent text/sender/attachments and copy any attachments into the sandbox
 * so the model can Read them just like current-batch attachments.
 */
export function buildReplyContext(
  batch: InboundMessage[],
  sandboxPath: string,
  deps: Deps,
): Map<string, { context: ReplyContext; senderLabel: string; attachmentPaths: string[] }> {
  const out = new Map<
    string,
    { context: ReplyContext; senderLabel: string; attachmentPaths: string[] }
  >();
  const { chatDb, contacts } = deps;
  for (const m of batch) {
    if (!m.replyToGuid) continue;
    if (out.has(m.replyToGuid)) continue;
    const parent = lookupReplyContext(chatDb, m.replyToGuid);
    if (!parent) continue;
    const senderLabel = parent.fromMe
      ? "You"
      : (contacts.displayName(parent.fromHandle) ?? parent.fromHandle ?? "?");
    const copied = copyAttachments(sandboxPath, parent.attachments, new Date(parent.timestampMs));
    const attachmentPaths = parent.attachments.map((src) => copied.get(src) ?? src);
    out.set(m.replyToGuid, { context: parent, senderLabel, attachmentPaths });
  }
  return out;
}

/**
 * Assemble the group-aware history view.
 *
 * Strategy:
 *
 *   1. Pull a generous candidate window (config.history_candidate_window,
 *      default 80) ending just before the inbound batch.
 *   2. Split into segments at silences ≥ thread_break_minutes (default 30
 *      min). The latest segment is the "active thread" — everything else
 *      is prior conversation that's not relevant to the current turn.
 *   3. Trim the active segment to `history_max_per_segment` (default 30).
 *      If trimmed, prefix the rendered output with a one-liner the model
 *      can read so it knows earlier messages exist (and can fetch them
 *      with `get_thread_context`).
 *   4. Find internal topic-shift gaps (≥ topic_shift_minutes, default 5
 *      min) and inject `--- Xm gap ---` markers in the rendered lines.
 *   5. Compute the scope descriptor from elapsed time + segment shape +
 *      whether the model has spoken in this thread already.
 *   6. Classify the invocation (direct / mid_thread / passing_reference
 *      / cold) — descriptive only, never used as a gating decision.
 *
 * DMs keep the old behavior: nothing on warm turns, full history on cold
 * starts. DMs are dyadic — speaker attribution and topic segmentation
 * don't earn their keep there.
 */
export function buildHistoryBundle(
  first: InboundMessage,
  inboundBatch: InboundMessage[],
  coldStart: boolean,
  isGroup: boolean,
  lastOutboundMs: number,
  deps: Deps,
  sessionKey: SessionKey,
): HistoryBundle {
  const { config, chatDb, contacts } = deps;
  if (config.behavior.history_messages === 0) {
    return { lines: [], scope: undefined, invocation: undefined, catchUpNudge: undefined };
  }

  // SMS sessions: chat.db has never heard of a Twilio conversation, so the
  // transcript lives in SmsStore and arrives through the deps.sms closure.
  // Without this branch the queries below would "succeed" with zero rows and
  // every SMS turn would present as a first meeting — the structural zero
  // that looks exactly like a quiet thread.
  if (isSmsSession(sessionKey)) {
    if (!deps.sms) {
      return { lines: [], scope: undefined, invocation: undefined, catchUpNudge: undefined };
    }
    // Same cold-start economics as the DM path: warm turns carry no history
    // block (the model has the running conversation), cold starts get the
    // recent transcript so the person is never re-introduced to Edmund.
    const full = config.behavior.history_always || coldStart;
    if (!full && !isGroup) {
      return { lines: [], scope: undefined, invocation: undefined, catchUpNudge: undefined };
    }
    const raw = deps.sms.history(chatIdFromKey(sessionKey), config.behavior.history_messages);
    const lines = formatHistoryLines(raw, contacts);
    return {
      lines,
      scope:
        isGroup && lines.length > 0
          ? `${lines.length} recent messages in this group text`
          : undefined,
      invocation: undefined,
      catchUpNudge: undefined,
    };
  }

  // Per-orchestrator visibility: chat.db is shared across personas, so the
  // raw rows are filtered to what THIS session's orchestrator may see — the
  // primary never sees a secondary's invocations or replies. Constant-true
  // when no [[orchestrators]] are configured.
  const visible = makeHistoryFilter(
    viewerForSession(sessionKey),
    first.chatGuid,
    config,
    deps.state,
  );

  // ---- DM path (unchanged behavior) ----
  if (!isGroup) {
    const full = config.behavior.history_always || coldStart;
    if (!full) {
      return { lines: [], scope: undefined, invocation: undefined, catchUpNudge: undefined };
    }
    const lines = getRecentMessages(
      chatDb,
      first.chatGuid,
      first.rowId,
      config.behavior.history_messages,
    ).filter(visible);
    return {
      lines: formatHistoryLines(lines, contacts),
      scope: undefined,
      invocation: undefined,
      catchUpNudge: undefined,
    };
  }

  // ---- Group path: segment + classify ----
  const candidateLimit = config.behavior.history_candidate_window;
  const candidates = getRecentMessages(chatDb, first.chatGuid, first.rowId, candidateLimit).filter(
    visible,
  );
  if (candidates.length === 0) {
    return {
      lines: [],
      scope: "no prior messages in this chat",
      invocation: "cold",
      catchUpNudge: undefined,
    };
  }

  const breakMs = config.behavior.thread_break_minutes * 60_000;
  const minorBreakMs = config.behavior.topic_shift_minutes * 60_000;
  const inboundMs = first.timestampMs;
  const segments = segmentByGaps(candidates, breakMs);
  const active = pickActiveSegment(segments, inboundMs);
  if (!active) {
    return {
      lines: [],
      scope: "no prior messages in this chat",
      invocation: "cold",
      catchUpNudge: undefined,
    };
  }

  const gapToInbound = inboundMs - active.endMs;
  const isolatedFromActive = gapToInbound >= breakMs;

  const cap = config.behavior.history_max_per_segment;
  const fullCount = active.lines.length;
  const omitted = Math.max(0, fullCount - cap);
  const trimmed = omitted > 0 ? active.lines.slice(-cap) : active.lines;

  const shifts = findTopicShifts({ ...active, lines: trimmed }, minorBreakMs);

  const renderedLines = formatHistoryLines(trimmed, contacts, shifts);
  if (omitted > 0) {
    renderedLines.unshift(
      `  (${omitted} earlier message${omitted === 1 ? "" : "s"} in this thread omitted — call get_thread_context to fetch them)`,
    );
  }

  const invocation = classifyInvocation({
    inboundBatch,
    isolatedFromActive,
    activeMs: active.endMs - active.startMs,
    activeCount: fullCount,
    distinctSpeakers: countDistinctSpeakers(active.lines),
    botSpokeInActive: lastOutboundMs >= active.startMs && lastOutboundMs <= active.endMs,
    identityNames: config.identity.names,
  });

  const scope = describeScope({
    activeCount: fullCount,
    activeSpanMs: active.endMs - active.startMs,
    omitted,
    isolatedFromActive,
    gapToInbound,
    botSpokeInActive: lastOutboundMs >= active.startMs && lastOutboundMs <= active.endMs,
    msSinceBotSpoke: lastOutboundMs > 0 ? Date.now() - lastOutboundMs : null,
    distinctSpeakers: countDistinctSpeakers(active.lines),
    shifts: shifts.length,
  });

  const threshold = config.behavior.auto_catchup_threshold;
  const sinceLastSpoke =
    lastOutboundMs > 0 ? candidates.filter((l) => l.timestampMs > lastOutboundMs).length : 0;
  const catchUpNudge =
    threshold > 0 && sinceLastSpoke >= threshold
      ? buildCatchUpNudge(sinceLastSpoke, Date.now() - lastOutboundMs)
      : undefined;

  return { lines: renderedLines, scope, invocation, catchUpNudge };
}

/**
 * The nudge shown on the single coalesced turn we run per chat after the daemon was DOWN.
 * Frames recovery the way a person experiences it: a phone that died, just got power, and is
 * flooded with texts. They scan it all and reply naturally to what still matters — they do NOT
 * fire off a separate reply to every message. That's the behavior we want here.
 */
export function buildDowntimeNudge(messageCount: number, downtimeMs: number): string {
  const span = formatDuration(downtimeMs);
  return [
    `[you were offline ~${span}] You just came back online after being down — like a phone that died and finally got power back. While you were gone, ${messageCount} message${messageCount === 1 ? "" : "s"} piled up in this chat.`,
    `Catch up the way a person does with a flood of texts: read what was said (call \`catch_me_up\` for the full picture, including media), then send AT MOST ONE reply — only to what genuinely still needs a response. It is completely fine, and usually right, to stay SILENT if the moment passed or it was just chatter.`,
    `Do NOT reply to messages one-by-one. Do NOT re-explain your absence beyond a quick aside, if at all. Especially in a group chat: a single natural catch-up message, or none, is correct. Never spam.`,
  ].join("\n");
}

function buildCatchUpNudge(messageCount: number, msSinceSpoke: number): string {
  const span = formatDuration(msSinceSpoke);
  return [
    `[heads-up] It's been ${span} since you last spoke in this chat and ${messageCount} message${messageCount === 1 ? "" : "s"} have piled up. Before composing a reply, strongly consider calling \`catch_me_up\` — it'll read everything (including media) and return a structured recap in ~5–15s, so you can respond with the full picture instead of guessing. Skip this only if the inbound is clearly self-contained and doesn't reference anything from the gap.`,
  ].join("\n");
}

function countDistinctSpeakers(lines: { fromHandle: string; fromMe: boolean }[]): number {
  const set = new Set<string>();
  for (const l of lines) set.add(l.fromMe ? "me" : l.fromHandle);
  return set.size;
}

function classifyInvocation(args: {
  inboundBatch: InboundMessage[];
  isolatedFromActive: boolean;
  activeMs: number;
  activeCount: number;
  distinctSpeakers: number;
  botSpokeInActive: boolean;
  identityNames: string[];
}): "direct" | "mid_thread" | "passing_reference" | "cold" {
  const text = args.inboundBatch.map((m) => m.text).join("\n");
  if (isPassingReference(text, args.identityNames)) return "passing_reference";
  if (args.isolatedFromActive || args.activeCount <= 1) return "cold";
  if (args.distinctSpeakers >= 2 && !args.botSpokeInActive) return "mid_thread";
  return "direct";
}

/**
 * "Passing reference" detector. The model's name appears in the inbound
 * text, but not in any position that suggests being addressed:
 *   - no `@<name>` form
 *   - no leading `<name>, ...` or `hey <name>, ...` form
 *   - no question-mark sentence that immediately follows the name
 * Returns true only when we're confident the message is about the bot,
 * not to it. False (= treat as normal) when ambiguous.
 */
function isPassingReference(text: string, names: string[]): boolean {
  const lower = text.toLowerCase().trim();
  if (lower.length === 0) return false;
  for (const name of names) {
    const n = name.toLowerCase();
    if (new RegExp(`@${escapeRe(n)}\\b`).test(lower)) return false;
    if (new RegExp(`^(hey |ok |yo |@)?${escapeRe(n)}[,:\\s]`).test(lower)) return false;
    if (new RegExp(`\\b${escapeRe(n)}\\b[^?]*\\?`).test(lower)) return false;
  }
  return names.some((n) => new RegExp(`\\b${escapeRe(n.toLowerCase())}\\b`).test(lower));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeScope(args: {
  activeCount: number;
  activeSpanMs: number;
  omitted: number;
  isolatedFromActive: boolean;
  gapToInbound: number;
  botSpokeInActive: boolean;
  msSinceBotSpoke: number | null;
  distinctSpeakers: number;
  shifts: number;
}): string {
  const span = formatDuration(args.activeSpanMs);
  const speakers = args.distinctSpeakers;
  const shifts = args.shifts;

  if (args.isolatedFromActive) {
    const gap = formatDuration(args.gapToInbound);
    return `prior conversation was ${gap} ago (likely unrelated). Showing only the current thread — ${args.activeCount} msg${args.activeCount === 1 ? "" : "s"} over ${span}.`;
  }

  const lead =
    args.omitted > 0
      ? `${args.activeCount} msgs over ${span} (showing last ${args.activeCount - args.omitted})`
      : `${args.activeCount} msg${args.activeCount === 1 ? "" : "s"} over ${span}`;

  const voicePart =
    speakers >= 2 ? `, ${speakers} speakers` : speakers === 1 ? ", single speaker" : "";
  const shiftPart =
    shifts > 0 ? `, ${shifts} topic shift${shifts === 1 ? "" : "s"} (see --- gap --- markers)` : "";

  const reply =
    args.botSpokeInActive && args.msSinceBotSpoke !== null
      ? ` You last replied in this thread ${formatDuration(args.msSinceBotSpoke)} ago.`
      : speakers >= 2
        ? " You haven't replied in this thread yet."
        : "";

  return `${lead}${voicePart}${shiftPart}.${reply}`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** Window for surfacing tapbacks on the bot's messages — recent enough to be
 *  worth noting, short enough that an old reaction doesn't reappear in the
 *  envelope turn after turn. */
const REACTION_WINDOW_MS = 3 * 3_600_000;

export function buildReactionLines(key: SessionKey, deps: Deps): string[] {
  const { chatDb, contacts } = deps;
  let guids: string[];
  try {
    guids = chatGuidsForSession(key, chatDb, contacts);
  } catch {
    return [];
  }
  const items = recentReactionsToMe(chatDb, guids, {
    sinceMs: Date.now() - REACTION_WINDOW_MS,
    limit: 5,
  });
  if (items.length === 0) return [];
  return items.map((r) => {
    const who = contacts.displayName(r.reactorHandle) ?? (r.reactorHandle || "someone");
    const d = new Date(r.atMs);
    const when = `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d
      .getHours()
      .toString()
      .padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    const snippet = r.targetText.trim().replace(/\s+/g, " ");
    const quoted = snippet
      ? `"${snippet.length > 70 ? `${snippet.slice(0, 70)}…` : snippet}"`
      : "(an earlier message)";
    return `  ${when} ${who} ${r.glyph} ${quoted}`;
  });
}
