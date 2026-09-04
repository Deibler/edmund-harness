import type { AgentStore } from "../agents/store.ts";
import type { OperatorAlert } from "../alerts/operator-alert.ts";
import type { BgJobStore } from "../background/store.ts";
import type { Config } from "../config/config.ts";
import type { CronStore } from "../cron/store.ts";
import type { GhostObserver } from "../ghost/observer.ts";
import type { GuestStore } from "../guests/store.ts";
import type { ChatDb } from "../imessage/db.ts";
import type { AutoRecallResult } from "../memory/auto-recall.ts";
import type { PersonMaintainer } from "../persona/maintainer-observer.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import type { EchoCache } from "../sessions/echo-cache.ts";
import type { SessionKey } from "../sessions/key.ts";
import type { SessionLocks } from "../sessions/locks.ts";
import type { StateStore } from "../sessions/store.ts";
import type { SessionPipeline } from "./pipeline.ts";

/**
 * Shared dependency bag for the turn pipeline. Built once in src/boot/wire.ts
 * and threaded through handleBatch + helpers so each function has explicit
 * access to the long-lived stores without reaching for module-level state.
 */
export type Deps = {
  config: Config;
  state: StateStore;
  contacts: ContactBook;
  echoes: EchoCache;
  chatDb: ChatDb;
  alert: OperatorAlert;
  crons: CronStore;
  /** Guest-access store (activations, vouches, buffers, caps). Absent in
   *  test fixtures ⇒ every DM is treated as the full operator tier. */
  guests?: GuestStore;
  /** Sessions currently running a claude -p process. Used to route follow-up messages to the pending queue. */
  activeSessions: Set<SessionKey>;
  /** Exact in-flight model turn per session, used for user-driven interruption. */
  turnControllers: Map<SessionKey, AbortController>;
  /**
   * Set right after construction. The coalesce gate uses it to re-enqueue
   * parked messages as a fresh turn when the model keeps its draft
   * (`KEEP_DRAFT`) or goes tool-only.
   */
  pipeline?: SessionPipeline;
  /** The per-session mutex shared by pipeline/cron/recovery. handleBatch
   *  uses it to run a tripped /compact in its OWN locked section after the
   *  turn's section releases (absent only in test fixtures → compact skipped). */
  locks?: SessionLocks;
  /** Live Mirror-only projection of the authoritative model/turn lifecycle. */
  mirrorLifecycle?: {
    onStarted: (turnId: string) => void | Promise<void>;
    onActivity: (
      turnId: string,
      phase: "thinking" | "working" | "responding",
      /** Plain-language note on what the model is doing right now. */
      detail?: string,
    ) => void | Promise<void>;
    onTextDelta: (turnId: string, text: string) => void | Promise<void>;
    onSettled: (
      turnId: string,
      outcome: "tool-only" | "silent" | "error" | "interrupted" | "delivered",
    ) => void | Promise<void>;
  };
  /** Brown-nose observer (Phase 4): notified after every successful
   *  outbound so the ghost can plant a future hook based on the
   *  freshly-finished exchange. */
  ghostObserver?: GhostObserver;
  /** Persona-file maintainer: notified after every successful outbound
   *  so the background pass can update `persona/people/<handle>.md` or
   *  `persona/groups/<slug>.md` based on the recent exchange. Decoupled
   *  from the brown-nose ghost — turning proactive outreach off does
   *  not mute memory hygiene. */
  personMaintainer?: PersonMaintainer;
  /** Auto-recall: optional closure that returns top-N similar past
   *  messages for the given inbound text + chat. main.ts wires the
   *  closure when memory_recall is enabled; absent = feature off.
   *  Result is split into a recency-boosted "recent" block and an
   *  older "deep memory" block; envelope renders them separately.
   *
   *  Uses the real AutoRecallResult rather than a structural copy. There
   *  were three near-identical inline copies of this shape, and adding a
   *  field to the source silently dropped it at every one — the compiler
   *  cannot warn about a subset that is still assignable. */
  /** SMS channel (Twilio) — transcript + group roster provider. Wired by
   *  main.ts when [sms] is enabled; absent = feature off. Closures rather
   *  than the SmsStore itself, so channels/ takes no import of src/sms/ and
   *  test fixtures can stub two functions instead of a database. */
  sms?: {
    /** Recent lines for one conversation (DM handle or CH… sid), oldest→newest. */
    history: (
      conversationId: string,
      limit: number,
    ) => import("../imessage/history.ts").HistoryLine[];
    /** Roster + name for a group conversation, or null when unknown. */
    groupInfo: (
      conversationSid: string,
    ) => { friendlyName: string | null; participants: string[] } | null;
  };
  autoRecall?: (
    chatGuid: string,
    queryText: string,
    senderHandle?: string | null,
    sessionKey?: SessionKey,
  ) => Promise<AutoRecallResult>;
};
