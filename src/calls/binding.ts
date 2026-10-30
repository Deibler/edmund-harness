/**
 * Which conversations are on a call right now, and how to speak into them.
 *
 * While a call is live, its conversation's session has a voice binding: the
 * turn path streams the model's text to it, and replies the session would
 * have texted are spoken instead. Everything else about the session — tools,
 * agents, memory, recall — is untouched, which is what makes a call a mode of
 * the conversation rather than a separate one.
 *
 * Module-level like the SMS and mirror deliverers in channels/deliver.ts: the
 * turn path, the cron path and delivery all consult it, and threading a
 * registry through each would touch every caller for one lookup.
 */

import type { InboundMessage } from "../imessage/types.ts";
import type { SessionKey } from "../sessions/key.ts";

/** The `service` a caller's utterance carries through the pipeline. It is a
 *  field the pending queue preserves, so it survives a park and replay. */
export const CALL_SERVICE = "FaceTime";

export function isCallUtterance(msg: Pick<InboundMessage, "service">): boolean {
  return msg.service === CALL_SERVICE;
}

let sequence = 0;
/**
 * Row ids for utterances are negative. chat.db ROWIDs are positive, and the
 * ack cursor clears `row_id <= max(batch)`: a positive synthetic id (the
 * mirror's `now * 1000`) in a DM session would clear the acks of every real
 * text that arrived during the call. Negative ids can never raise that max.
 */
export function callRowId(nowMs = Date.now()): number {
  sequence = (sequence + 1) % 1000;
  return -(nowMs * 1000 + sequence);
}

/** How a turn's reply went when the conversation was on a call. */
export type VoiceOutcome =
  /** Spoken, or queued to be spoken. */
  | "spoken"
  /** Nothing speakable (a sentinel, an empty reply, a cut-off turn). */
  | "silent"
  /** No live call, or it could not speak: deliver as text instead. */
  | "unavailable";

export type TurnSettlement = "tool-only" | "silent" | "error" | "interrupted" | "delivered";

export interface VoiceBinding {
  readonly callId: string;
  /** Speak a reply. `turnId` is set for turn replies, absent for cron ones. */
  deliver(text: string, turnId?: string): Promise<VoiceOutcome>;
  onTurnStarted(turnId: string): void;
  onTextDelta(turnId: string, text: string): void;
  onTurnSettled(turnId: string, outcome: TurnSettlement): void;
  /** The per-turn "you are on a call" block for the envelope. */
  envelopeBlock(): string;
}

const bindings = new Map<SessionKey, VoiceBinding>();

export function bindVoice(sessionKey: SessionKey, binding: VoiceBinding): void {
  bindings.set(sessionKey, binding);
}

/** Identity-checked so a late unbind from an old call cannot drop a new one. */
export function unbindVoice(sessionKey: SessionKey, callId: string): void {
  if (bindings.get(sessionKey)?.callId === callId) bindings.delete(sessionKey);
}

export function voiceBindingFor(sessionKey: SessionKey): VoiceBinding | null {
  return bindings.get(sessionKey) ?? null;
}

export function isVoiceLive(sessionKey: SessionKey): boolean {
  return bindings.has(sessionKey);
}

/** Test seam. */
export function clearVoiceBindings(): void {
  bindings.clear();
}
