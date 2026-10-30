/**
 * The shapes every call provider and every call companion agree on.
 *
 * A provider is a way of being on a call: FaceTime today, perhaps a phone
 * line later. It reports what is happening and does what it is told; it never
 * decides who may call, which conversation a call belongs to, or what to say.
 * Those belong to the CallManager, so a second provider gets every rule for
 * free and cannot quietly skip one.
 */

import type { SessionKey } from "../sessions/key.ts";

/** Who is on the other end, as the provider names them. */
export type Peer =
  | { kind: "person"; handle: string }
  /** A group call, identified by the Messages group it belongs to
   *  (chat.db `chat.group_id`). */
  | { kind: "group"; messagesGroupId: string; handles: string[] };

export type CallDirection = "incoming" | "outgoing";

/** A provider's call state, normalised. */
export type CallState = "ringing" | "dialing" | "active" | "ending" | "ended";

export type ProviderCall = {
  /** The provider's own id for the call. */
  id: string;
  direction: CallDirection;
  state: CallState;
  /** Null when the provider could not say who it is (never answered). */
  peer: Peer | null;
  /** Provider-specific detail, for logs only. Never a decision input. */
  raw?: unknown;
};

/** What a provider reports. Times are unix ms. */
export type ProviderEvent =
  | { type: "call"; call: ProviderCall }
  /** Recognised speech from the other side. `final` text is settled. */
  | { type: "heard"; text: string; final: boolean; atMs: number }
  /** The other side started or stopped talking. */
  | { type: "speech"; talking: boolean; atMs: number }
  /** One chunk of Edmund's speech finished; `played` is false if flushed. */
  | { type: "spoken"; chunkId: string; played: boolean }
  /** A physical output was audible and has been silenced again. */
  | { type: "silence-breach"; device: string; detail: string }
  /** Whether the provider can place and take calls right now. */
  | { type: "readiness"; ready: boolean; detail: string };

export interface CallProvider {
  /** Shown to the model and in logs ("FaceTime"). */
  readonly name: string;
  start(onEvent: (event: ProviderEvent) => void): Promise<void>;
  stop(): Promise<void>;
  dial(handle: string): Promise<ProviderCall>;
  answer(callId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
  /** Start reporting `heard` and `speech` for the call in progress. */
  listen(): Promise<void>;
  /**
   * Resolves once the other side can hear what say() sends. Not ok means it
   * never became so, with what was seen instead. Anything said before this
   * resolves is lost: a call reports active before its microphone opens.
   */
  audioReady(): Promise<{ ok: true } | { ok: false; detail: string }>;
  stopListening(): Promise<void>;
  /** Queue 16-bit mono PCM for the other side to hear. */
  say(chunkId: string, pcm: Uint8Array, sampleRate: number): Promise<void>;
  /** Drop everything queued to be heard (the caller started talking). */
  flush(): Promise<void>;
}

/** Text to speech. Null means it could not speak this time. */
export interface Speaker {
  synthesize(text: string): Promise<{ pcm: Uint8Array; sampleRate: number } | null>;
}

/** The conversation a call belongs to. Derived from keyed sources only. */
export type CallConversation = {
  sessionKey: SessionKey;
  /** The real chat.db GUID ("" for a person never texted). Never the key. */
  chatGuid: string;
  isGroup: boolean;
  /** How the model and the logs name the other side. */
  label: string;
  /** Canonical handle of the person; for a group, the members' handles. */
  handles: string[];
};

export type Utterance = {
  speaker: "caller" | "edmund";
  text: string;
  atMs: number;
  /** For Edmund's lines: false when a barge-in cut it off unheard. */
  heard: boolean;
};

/** A call as companions see it. */
export type CallRecord = {
  id: string;
  provider: string;
  direction: CallDirection;
  conversation: CallConversation;
  /** Session that asked for an outgoing call, when it was not the callee's. */
  requestedBy: SessionKey | null;
  reason: string | null;
  startedAtMs: number;
  answeredAtMs: number | null;
  endedAtMs: number | null;
  endReason: string | null;
  /** Agents the conversation's in-flight work was handed to at ring time. */
  handedOff: string[];
};

/**
 * Something that runs alongside every call: the transcript writer, the
 * notetaker, the memory feed. A new adjacent worker is a new companion; the
 * manager does not change. Companions observe; they never steer the call.
 * A companion that throws is logged and skipped, never fatal to the call.
 */
export interface CallCompanion {
  readonly name: string;
  onStart?(call: CallRecord): void | Promise<void>;
  onUtterance?(call: CallRecord, utterance: Utterance): void | Promise<void>;
  onEnd?(call: CallRecord): void | Promise<void>;
}
