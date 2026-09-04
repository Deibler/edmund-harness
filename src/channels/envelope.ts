import type { InboundMessage, ReplyContext } from "../imessage/types.ts";
import type { RecentItem } from "../persona/recent-received.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { envelopeStamp } from "../util/clock.ts";
import type { PrefetchEntry } from "../web/link-prefetch.ts";

/**
 * What kind of moment is this invocation? Computed in main.ts from the
 * envelope's history window + the inbound batch; rendered as a single
 * descriptor line at the top of group turns so the model knows whether
 * it's being pulled into an active multi-voice thread, addressed
 * directly, or referenced in passing.
 *
 *   "direct"           — addressed by one person after a clear lull
 *   "mid_thread"       — @-mentioned during active multi-voice discussion
 *   "passing_reference"— name appeared but the message isn't directed at it
 *   "cold"             — fresh context, prior conversation is far away/unrelated
 */
type InvocationKind = "direct" | "mid_thread" | "passing_reference" | "cold";

export type EnvelopeContext = {
  messages: InboundMessage[];
  /** Display name if known; handle otherwise. */
  senderLabel: string;
  /** Unix ms of the session's previous inbound, if any. */
  lastInboundMs: number | null;
  /** true if group chat */
  isGroup: boolean;
  /** Group-only: formatted participant display names. */
  participants?: string[];
  /** Optional chat display name (for named groups). */
  chatName?: string | null;
  /** ContactBook for resolving sender handles → display names in the body.
   *  Required when isGroup is true and the batch may contain multiple
   *  senders; optional otherwise (kept undefined and we fall back to the
   *  legacy "single From: header" formatting). */
  contacts?: ContactBook;
  /** Pre-formatted history lines to inject (empty = don't include a history block). */
  historyLines?: string[];
  /** One-line scope summary describing the window choice (groups only).
   *  E.g. "12 msgs over 18m, active thread. You last replied 6m ago." */
  historyScope?: string;
  /** What kind of invocation this is (groups only). Surfaced verbatim above
   *  the body so the persona can branch on it. */
  invocation?: InvocationKind;
  /** Auto-nudge: when set, an attention-grabbing block is rendered at the
   *  very top of the envelope reminding the model to call `catch_me_up`
   *  before composing. Fires when N+ messages have accumulated since the
   *  model last replied (configurable). The string is the rendered nudge
   *  line; main.ts builds it from the candidate count. */
  catchUpNudge?: string;
  /** Pre-formatted lines describing recent tapbacks on the bot's own messages. */
  reactionLines?: string[];
  /** Whisper transcripts keyed by attachment path; rendered inline with Attachments:. */
  transcripts?: Map<string, string>;
  /** Pre-rendered per-attachment annotations (video metadata + speech, built
   *  in turn.ts). Takes precedence over the bare transcript render for the
   *  same path so a video isn't double-annotated. */
  attachmentNotes?: Map<string, string>;
  /** Parent-of-reply context per msgGuid: resolved text + attachment paths. */
  replies?: Map<string, { context: ReplyContext; senderLabel: string; attachmentPaths: string[] }>;
  /** Top-N most-recent files in the sandbox's received-* buckets. */
  recentReceived?: RecentItem[];
  /** Pre-fetched content for URLs found in inbound messages. */
  linkContext?: PrefetchEntry[];
  /**
   * Count of attachments the user sent that did NOT finish downloading
   * from iMessage before the wait window expired. Set by main.ts after
   * `copyReceivedAttachments`. Surfaced in the envelope header so the
   * model knows the user *tried* to send something — and so it doesn't
   * say "your image didn't come through" while a phantom `/var/folders/...`
   * path appears in the now-stripped Attachments list. A follow-up
   * inbound usually arrives within a few seconds carrying the same
   * content properly inlined.
   */
  pendingAttachments?: number;
  /**
   * Auto-recall: pre-formatted lines from the semantic index — older
   * messages in this chat that are similar to the inbound text. Surfaced
   * verbatim as a "Relevant past messages" block. Already filtered to
   * exclude messages inside the rendered recent-thread window, so
   * there's no overlap with `historyLines`.
   */
  /**
   * Group chats only: hits scoped to the current inbound sender within
   * this chat ("what <senderLabel> has said before in this chat"),
   * rendered ABOVE the chat-scoped block. Empty / undefined in DMs.
   */
  autoRecallSenderLines?: string[];
  /** Display name for the sender-in-chat block header. */
  autoRecallSenderLabel?: string;
  autoRecallLines?: string[];
  /**
   * Auto-recall "deep memory" block: hits older than the deep-split
   * boundary (default 30 days). Rendered as a separate block so the
   * model orients on long-horizon context distinctly from recent
   * matches. Pure cosine ranking, no recency boost.
   */
  autoRecallDeepLines?: string[];
  /** At most one skill name whose description matched this message. */
  skillSuggestions?: string[];
};

/**
 * Build the text `claude -p` reads on stdin. Single framed block per turn:
 *
 *   [iMessage · Group · Sat 2026-04-19 15:04 · 12m since last]
 *   Chat: Weekend Squad
 *   Participants: Jordan, Riley, You
 *   From: Jordan
 *   Attachments: /path/a.jpg
 *
 *   Recent thread:
 *     Sat 14:58 Jordan: hey edmund
 *     Sat 14:59 Riley: lol
 *
 *   ---
 *
 *   <current inbound text>
 */
export function buildEnvelope(ctx: EnvelopeContext): string {
  if (ctx.messages.length === 0) return "";
  const first = ctx.messages[0]!;
  const last = ctx.messages[ctx.messages.length - 1]!;
  const now = new Date(last.timestampMs);

  const header: string[] = [];
  header.push(
    first.service === "mirror"
      ? `[Mirror · voice · ${formatTime(now)}${formatElapsed(ctx.lastInboundMs, first.timestampMs)}]`
      : first.service === "SMS"
        ? `[SMS · ${ctx.isGroup ? "Group text" : "DM"} · ${formatTime(now)}${formatElapsed(ctx.lastInboundMs, first.timestampMs)}]`
        : `[iMessage · ${ctx.isGroup ? "Group" : "DM"} · ${formatTime(now)}${formatElapsed(ctx.lastInboundMs, first.timestampMs)}]`,
  );
  // SMS venue realities, stated where the model decides how to answer: the
  // channel is plain text with a per-segment cost, and the iMessage verbs it
  // reaches for by habit (tapbacks, effects, replies-to) do not exist here.
  if (first.service === "SMS") {
    header.push(
      "Channel: SMS, not iMessage — same conversation, same you; only the medium differs. " +
        "Plain text only: no tapbacks, effects, typing bubbles, or reply-threading. " +
        "Long replies arrive as several separate texts, so write like you text: short. Links always in full, never shortened.",
    );
  }
  if (ctx.chatName) header.push(`Chat: ${ctx.chatName}`);
  if (ctx.isGroup && ctx.participants && ctx.participants.length > 0) {
    header.push(`Participants: ${ctx.participants.join(", ")}`);
  }
  header.push(`From: ${ctx.senderLabel}`);
  if (ctx.isGroup && ctx.invocation) {
    header.push(`Invocation: ${describeInvocation(ctx.invocation)}`);
  }
  if (ctx.pendingAttachments && ctx.pendingAttachments > 0) {
    header.push(
      `Pending attachments: ${ctx.pendingAttachments} (still downloading from iMessage — a follow-up turn with the same content properly inlined will likely arrive within seconds; do NOT tell the user their image "didn't come through" or ask them to resend yet, just acknowledge naturally or stay quiet until the next turn)`,
    );
  }
  const attachments = ctx.messages.flatMap((m) => m.attachments);
  if (attachments.length > 0) {
    const rendered = attachments.map((p) => {
      const note = ctx.attachmentNotes?.get(p);
      if (note) return `${p} ${note}`;
      const t = ctx.transcripts?.get(p);
      return t ? `${p} [voice transcript: "${t}"]` : p;
    });
    header.push(`Attachments: ${rendered.join(", ")}`);
  }

  const sections: string[] = [];
  if (ctx.catchUpNudge) sections.push(ctx.catchUpNudge);
  sections.push(header.join("\n"));

  if (ctx.historyLines && ctx.historyLines.length > 0) {
    const scopeLine = ctx.historyScope ? `History scope: ${ctx.historyScope}\n` : "";
    sections.push(
      `${scopeLine}Recent thread (you can react to — or thread an inline reply to — any message here, not only the latest):\n${ctx.historyLines.join("\n")}`,
    );
  }

  // Auto-recall, group chats: sender-scoped block FIRST so the model
  // sees "what this specific person has said in this room before"
  // before the more general chat-scoped matches.
  if (
    ctx.autoRecallSenderLines &&
    ctx.autoRecallSenderLines.length > 0 &&
    ctx.autoRecallSenderLabel
  ) {
    sections.push(
      `Past from ${ctx.autoRecallSenderLabel} in this chat (semantic match scoped to this person's prior messages here):\n${ctx.autoRecallSenderLines.join("\n")}`,
    );
  }

  // Auto-recall: semantically similar past messages from this chat
  // that fall *outside* the recent-thread window. Pre-fetched so the
  // model doesn't need to call `semantic_search` for the common case.
  // Two blocks — newer matches first (recency-boosted), then a deep-
  // memory block for matches older than ~30 days (pure cosine).
  if (ctx.autoRecallLines && ctx.autoRecallLines.length > 0) {
    sections.push(
      `Relevant past messages (semantic match, weighted toward recent; outside the recent-thread window above; call \`semantic_search\` if you need more):\n${ctx.autoRecallLines.join("\n")}`,
    );
  }
  if (ctx.autoRecallDeepLines && ctx.autoRecallDeepLines.length > 0) {
    sections.push(
      `Deep memory (semantic match against older history, ranked by relevance not recency — could be weeks or months ago):\n${ctx.autoRecallDeepLines.join("\n")}`,
    );
  }

  // A skill whose stated purpose matches what they just asked for.
  //
  // This exists because discovery was not happening: over four months skills
  // were read on ~5% of turns, and 82% of those were the four the system
  // prompt names by hand. The rest were invisible — not unwanted, just never
  // thought of. Matching on the description (a dense statement of when to
  // reach for the skill) at the moment of intent puts the right one in front
  // of the model instead of relying on it to remember to go looking.
  //
  // One line, one skill, and framed as "you have a method for this" rather
  // than an instruction: a turn that genuinely does not need it must be able
  // to ignore this without friction, or the block becomes noise the model
  // learns to skip.
  if (ctx.skillSuggestions && ctx.skillSuggestions.length > 0) {
    const names = ctx.skillSuggestions.map((n) => `read_skill("${n}")`).join(" or ");
    sections.push(
      `You have a worked-out method for something in this message: ${names}. Read it before improvising — it exists because this came up before and the details matter. If it turns out not to fit what they actually want, ignore it and carry on.`,
    );
  }

  // Tapbacks people left on the bot's own recent messages. Informational —
  // it's the lightweight "I saw it / nice" signal, so the model usually
  // shouldn't reply to one; it's here so it isn't oblivious to the feedback.
  if (ctx.reactionLines && ctx.reactionLines.length > 0) {
    sections.push(
      `Reactions to your recent messages (FYI — usually no reply needed):\n${ctx.reactionLines.join("\n")}`,
    );
  }

  // Always surface a short list of recent received media so vague references
  // ("explain this", "what does it say") have immediate visual context even
  // when the user didn't thread the reply or re-attach the file.
  if (ctx.recentReceived && ctx.recentReceived.length > 0) {
    const lines = ctx.recentReceived.map((r) => {
      const when = formatTime(new Date(r.mtimeMs));
      return `  ${when} ${r.bucket}: ${r.path}`;
    });
    sections.push(`Recent media in this chat's sandbox:\n${lines.join("\n")}`);
  }

  // If any message in the batch replies to a prior one, surface that parent
  // so the model sees the image / text being referenced — not just the
  // three-word reply ("edmund explain this").
  const replyLines: string[] = [];
  for (const m of ctx.messages) {
    const reply = m.replyToGuid ? ctx.replies?.get(m.replyToGuid) : undefined;
    if (!reply) continue;
    const when = formatTime(new Date(reply.context.timestampMs));
    const who = reply.senderLabel;
    const snippet = reply.context.text.trim() || "(no text)";
    const attach =
      reply.attachmentPaths.length > 0
        ? `\n    Attachments: ${reply.attachmentPaths.join(", ")}`
        : "";
    replyLines.push(`  ${when} ${who}: ${snippet}${attach}`);
  }
  if (replyLines.length > 0) {
    sections.push(`In reply to:\n${replyLines.join("\n")}`);
  }

  if (ctx.linkContext && ctx.linkContext.length > 0) {
    const linkLines = ctx.linkContext.map((e) => {
      const heading = e.title ? `${e.title} (${e.url})` : e.url;
      return `[${heading}]\n${e.snippet}`;
    });
    sections.push(`Linked content (auto-fetched):\n\n${linkLines.join("\n\n---\n\n")}`);
  }

  const body = renderBody(ctx);

  sections.push(body);
  return sections.join("\n\n---\n\n");
}

/**
 * Body rendering. Single-message batches stay as plain text (the `From:`
 * header already tells the model who sent it). Multi-message batches get
 * timestamps; group batches additionally get speaker tags per message so
 * a rapid-fire multi-sender batch (Jordan pings, Riley follows up) is
 * unambiguous.
 */
function renderBody(ctx: EnvelopeContext): string {
  const msgs = ctx.messages;
  if (msgs.length === 1) return msgs[0]!.text;
  const multipleSenders =
    ctx.isGroup && new Set(msgs.map((m) => `${m.fromMe ? "me" : m.fromHandle}`)).size > 1;
  return msgs
    .map((m) => {
      const time = formatTime(new Date(m.timestampMs));
      if (multipleSenders) {
        const who = m.fromMe
          ? "You"
          : (ctx.contacts?.displayName(m.fromHandle) ?? m.fromHandle ?? "unknown");
        return `[${who} · ${time}] ${m.text}`;
      }
      return `(${time}) ${m.text}`;
    })
    .join("\n\n");
}

/**
 * Build the envelope main sees when the ghost has fired a brown-nose
 * opportunity. Unlike `buildEnvelope`, this has no inbound user message
 * — the model is being invited to consider an action.
 *
 * The persona is taught (VENUE_DM.md / VENUE_GROUP.md) to recognize the
 * `[Proactive opportunity · ...]` header and treat the body as a
 * recommendation it can act on OR veto with `KEEP_QUIET`.
 */
export function buildProactiveEnvelope(args: {
  brief: string;
  /** Absolute paths into <sandbox>/brownnose/ the ghost wants main to
   *  read for context (drafts, research). Optional. */
  contextFiles?: string[];
  /** Free-form telemetry tags from the ghost — surfaced verbatim so
   *  the persona can see "what bucket of move is this." */
  tags?: string[];
  /** Local-time formatted string for the header (caller resolves TZ). */
  localTimeLabel: string;
  /** The recipient's standing self-service portal link — when present,
   *  the model must close the message with a one-sentence note about the
   *  proactive feature + this link. */
  portalUrl?: string;
}): string {
  const sections: string[] = [];
  const header: string[] = [
    `[Proactive opportunity · ${args.localTimeLabel}]`,
    "The ghost recommended you consider acting now. You were NOT pinged by a user — this is unprompted. You have final veto: respond with exactly `KEEP_QUIET` (no quotes, no other words) if context has shifted or the move no longer lands. Otherwise produce the action (text, generated media, research, whatever fits).",
  ];
  if (args.tags && args.tags.length > 0) {
    header.push(`Tags: ${args.tags.join(", ")}`);
  }
  sections.push(header.join("\n"));

  sections.push(`Brief from the ghost:\n${args.brief}`);

  if (args.contextFiles && args.contextFiles.length > 0) {
    sections.push(
      `Working notes the ghost left in your sandbox (read with the Read tool if relevant):\n${args.contextFiles.map((p) => `  ${p}`).join("\n")}`,
    );
  }

  sections.push(
    [
      "Decision rubric (run this before committing):",
      "  1. Has the user just messaged me, or messaged about something else? If yes → KEEP_QUIET (don't pile on).",
      "  2. Is the brief still timely, or has the moment passed?",
      "  3. Is the move original, or am I about to repeat myself?",
      "  4. Would I actually use this output if I were the user?",
      "If any of these gives you pause, KEEP_QUIET. The cost of staying silent is small; the cost of an annoying unprompted message is large.",
      "",
      'If you act: DO THE WORK FIRST. An unprompted message must arrive carrying its value — the finished research, the generated image, the worked-out plan, the answer — not an offer to produce it. Never open with a question that creates work for the user ("want me to…?", "should I…?"); if the move needs their input to be worth anything, KEEP_QUIET and wait for a real hook. Lead with the result, keep it as short as a friend\'s text.',
    ].join("\n"),
  );

  if (args.portalUrl) {
    sections.push(
      [
        "REQUIRED FOOTER (only if you act): after a blank line, close the message with ONE casual sentence explaining this was you reaching out on your own + their personal settings link. In your own voice, varied each time — something like:",
        `  "ps — this was me reaching out on my own. you can tune when/whether I do that here: ${args.portalUrl}"`,
        "Keep it to one sentence + the link, never more. The link is theirs alone and always works.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n---\n\n");
}

function describeInvocation(kind: InvocationKind): string {
  switch (kind) {
    case "direct":
      return "direct — you were addressed by the sender";
    case "mid_thread":
      return "mid-thread — @mentioned during active multi-voice discussion (synthesize across voices before answering)";
    case "passing_reference":
      return "passing reference — your name appeared but the sender isn't asking you something (a light-touch reply or tapback is usually right; consider whether a reply is needed at all)";
    case "cold":
      return "cold — fresh context after a long gap; prior conversation is likely unrelated";
  }
}

function formatTime(d: Date): string {
  // Pinned to the owner's home timezone (Eastern). The weekday, date, and clock
  // must all come from the SAME zone — the old impl mixed a UTC date (via
  // toISOString) with a local weekday/clock, which after 8pm Eastern stamped
  // "tomorrow's" date onto today's weekday and made the model schedule every
  // evening reminder a day late. See src/util/clock.ts.
  return envelopeStamp(d);
}

function formatElapsed(lastMs: number | null, nowMs: number): string {
  if (!lastMs) return "";
  const delta = Math.max(0, nowMs - lastMs);
  if (delta < 60_000) return " · just now";
  if (delta < 3_600_000) return ` · ${Math.round(delta / 60_000)}m since last`;
  if (delta < 86_400_000) return ` · ${Math.round(delta / 3_600_000)}h since last`;
  return ` · ${Math.round(delta / 86_400_000)}d since last`;
}
