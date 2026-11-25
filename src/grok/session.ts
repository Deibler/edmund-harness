import type { InboundMessage } from "../imessage/types.ts";

/**
 * How a Grok connector request is recognised once it is inside the pipeline.
 *
 * ## No session of its own
 *
 * A Grok request is one more inbound in the person's ordinary iMessage DM
 * session (`imessage:dm:<handle>`, built by `sessionKeyFor` like any DM), so
 * the voice calls and the texts are one conversation with one memory. What
 * makes a request different is carried on the message itself, as with a
 * FaceTime utterance (`sessions/call-binding.ts`): the `service` tag below, and a
 * negative row id. Everything downstream keys on the message, never the
 * session: a text typed in the same conversation keeps its own debounce window,
 * envelope and delivery.
 *
 * The inbound carries the DM's real chat guid, so nothing that reads
 * `first.chatGuid` (the session row, the outbox, typing, attribution) ever sees
 * a synthetic one.
 *
 * The `grok:dm:<handle>` session this channel first used no longer exists as a
 * target. `isGrokSession` (sessions/key.ts) still recognises that key so stale
 * rows and old transcripts resolve.
 */

/** The `service` a connector request carries through the pipeline. It is a
 *  field the pending queue preserves, so it survives a park and replay. */
export const GROK_SERVICE = "Grok";

export function isGrokInbound(msg: Pick<InboundMessage, "service">): boolean {
  return msg.service === GROK_SERVICE;
}

/**
 * The `service` of a connector message nobody is waiting on. There are two:
 * `tell_edmund` (the caller handed him something and hung up) and
 * `report_to_edmund` (a Grok Bot handing back a task he gave it). Both ride the
 * pipeline like a spoken request, but the reply is an ordinary text to the
 * person's DM, never read aloud, and the envelope says so. A report is told
 * apart because it carries a bot's work product, not the person's words.
 */
export const GROK_TELL_SERVICE = "GrokTell";
export const GROK_REPORT_SERVICE = "GrokReport";

export function isGrokAsyncInbound(msg: Pick<InboundMessage, "service">): boolean {
  return msg.service === GROK_TELL_SERVICE || msg.service === GROK_REPORT_SERVICE;
}

export function isGrokReportInbound(msg: Pick<InboundMessage, "service">): boolean {
  return msg.service === GROK_REPORT_SERVICE;
}

/** Any message that came in through the connector, spoken or fire-and-forget. */
export function isGrokAnyInbound(msg: Pick<InboundMessage, "service">): boolean {
  return isGrokInbound(msg) || isGrokAsyncInbound(msg);
}

let sequence = 0;
/**
 * Row ids for requests are negative. chat.db ROWIDs are positive, and the ack
 * cursor clears `row_id <= max(batch)`: a positive synthetic id (a timestamp
 * times a thousand) in the DM session would clear the crash-recovery record of
 * every real text that arrived meanwhile. Negative ids can never raise that max,
 * and `historyBefore` reads them as "up to the latest message".
 */
export function grokRowId(nowMs = Date.now()): number {
  sequence = (sequence + 1) % 1000;
  return -(nowMs * 1000 + sequence);
}

/**
 * What a turn needs to know about the connector requests in its batch. Decided
 * per turn, from that turn's own batch, never from the session: the DM session
 * carries ordinary texts too, and a turn made only of those gets `undefined`
 * and is delivered exactly as before.
 */
export type GrokTurn = {
  /** The connector messages in this batch. Those that are spoken requests may
   *  still be waiting on the line for the reply; the fire-and-forget ones
   *  (tell_edmund, report_to_edmund) never wait but are logged with it. */
  msgGuids: string[];
  /** A spoken request is in the batch, so the reply may belong on the line. */
  spoken: boolean;
  /** A real iMessage is also owed the reply (the batch mixed them, or a text
   *  was folded into the turn), so it is texted as well as spoken. */
  alsoText: boolean;
};

export function grokTurnOf(batch: readonly InboundMessage[]): GrokTurn | undefined {
  const connector = batch.filter(isGrokAnyInbound);
  if (connector.length === 0) return undefined;
  return {
    msgGuids: connector.map((m) => m.msgGuid),
    spoken: connector.some(isGrokInbound),
    alsoText: connector.length < batch.length,
  };
}
