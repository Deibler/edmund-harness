/**
 * Messages shown to a turn while it runs.
 *
 * A message for a session whose turn was in flight used to wait in the pending
 * queue until the turn ended, unless the model thought to call check_incoming.
 * Over the 30 days to 2026-10-25, 330 turns ran past 3 minutes (35 group turns
 * past 10), 75 of them had someone waiting, and handoff_current_work was never
 * called. In a group the one waiting is often not the one who asked for the
 * work.
 *
 * The CLI reads stream-json stdin mid-turn and hands a new user message to the
 * model at its next tool step. So the daemon writes the message to the running
 * worker, and the model can answer with send_message and carry on. Steps in
 * those long turns came every 4.9 s at the median, 30 s at p90.
 *
 * Which ones the model saw is known from the --replay-user-messages echo. One
 * written during a tool step is echoed when it joins the conversation, before
 * the turn's result. One that lands while the model writes its final reply is
 * echoed after that result, as a turn of its own. The worker therefore writes
 * only while a tool step is in flight, and retires itself if the second case
 * happens anyway.
 */

import type { InboundMessage } from "../imessage/types.ts";
import { envelopeStamp } from "../util/clock.ts";
import { log, shortSession } from "../util/log.ts";

export type InjectResult = { ok: true; uuid: string } | { ok: false; reason: string };

/** uuids of messages shown mid-turn that the model saw, per session, until
 *  the turn that ran them collects them. */
const seen = new Map<string, Set<string>>();

export function recordSeenMidTurn(sessionKey: string, uuids: Iterable<string>): void {
  const set = seen.get(sessionKey) ?? new Set<string>();
  for (const u of uuids) set.add(u);
  if (set.size > 0) seen.set(sessionKey, set);
}

/** The session's seen uuids since the last call, and forget them. */
export function takeSeenMidTurn(sessionKey: string): Set<string> {
  const set = seen.get(sessionKey) ?? new Set<string>();
  seen.delete(sessionKey);
  return set;
}

/**
 * The note that shows a message to the running turn, or null for one it
 * cannot carry: an image or file rides only in a turn's own envelope, so a
 * message with one waits for the end of the turn as before. A voice note's
 * transcript is text and goes.
 */
export function midTurnNote(
  msg: InboundMessage,
  senderLabel: string,
  isGroup: boolean,
): string | null {
  const transcripts = msg.attachments
    .map((a) => msg.attachmentTranscripts?.[a])
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  if (msg.attachments.length > transcripts.length) return null;
  const text = (msg.text ?? "").trim();
  if (!text && transcripts.length === 0) return null;

  const lines = [
    "[SYSTEM — a new message arrived while you're working]",
    `${senderLabel} · ${envelopeStamp(new Date(msg.timestampMs))}:`,
    ...(text ? [text] : []),
    ...transcripts.map((t) => `(voice note) ${t.trim()}`),
  ];
  if (msg.msgGuid) lines.push(`(message id ${msg.msgGuid})`);
  const guidance = [
    "You are seeing this at your next step, not at the end of your turn.",
    ...(isGroup
      ? ["In a group it may be from someone other than whoever asked for your current task."]
      : []),
    "If it needs an answer, send it with send_message before your next tool call (reply_to the id above when the thread is busy), then carry on with your task.",
    "If it asks you to stop or change course, do that.",
    "If what is left of your task is long, handoff_current_work finishes it in the background so you stay in the conversation.",
    "It will not be shown to you again when this turn ends.",
  ];
  lines.push("", guidance.join(" "));
  return lines.join("\n");
}

/**
 * Show a message that arrived for a session with a turn in flight to that
 * turn. Returns the uuid it went under, or null when it only waits for the
 * end of the turn: no note for it, or the turn could not take one. Never
 * throws; the caller parks the message either way.
 */
export function showToRunningTurn(
  sessionKey: string,
  msg: InboundMessage,
  deps: {
    label: (handle: string) => string | null | undefined;
    inject: (sessionKey: string, text: string) => InjectResult;
  },
): string | null {
  try {
    const sender = deps.label(msg.fromHandle) ?? (msg.fromHandle || msg.chatIdentifier);
    const note = midTurnNote(msg, sender, msg.isGroup);
    if (!note) return null;
    const r = deps.inject(sessionKey, note);
    log.info("mid-turn", r.ok ? "shown to the running turn" : "left for the end of the turn", {
      session: shortSession(sessionKey),
      row: msg.rowId,
      ...(r.ok ? {} : { reason: r.reason }),
    });
    return r.ok ? r.uuid : null;
  } catch (err) {
    log.warn("mid-turn", "could not show to the running turn", {
      session: shortSession(sessionKey),
      err: (err as Error).message,
    });
    return null;
  }
}
