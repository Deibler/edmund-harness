import type { InboundMessage } from "../imessage/types.ts";
import { isMirrorSession } from "../sessions/key.ts";
import type { SessionKey } from "../sessions/key.ts";
import type { SessionLocks } from "../sessions/locks.ts";
import { abortActiveCompact } from "./compact-gate.ts";

export type BatchHandler = (sessionKey: SessionKey, batch: InboundMessage[]) => Promise<void>;

type Bucket = {
  queue: InboundMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Unix ms the first message currently in the queue was enqueued. null when empty. */
  firstAt: number | null;
};

export type PipelineOptions = {
  /** Idle window for plain-text messages — resets on each new message. */
  debounceMs: number;
  /** Debounce for voice sessions. See `windowFor`. Defaults to
   *  `min(debounceMs, 250)`. */
  voiceDebounceMs?: number;
  /** Hard cap from the first queued message regardless of further typing. */
  maxMs?: number;
  /** Idle window for a message that carries an attachment AND its own text (a caption). */
  captionedAttachmentMs?: number;
  /**
   * Idle window for a *bare* attachment (image/file with no text of its own).
   * Longer than the others: a bare photo is very often followed by a caption
   * or a question a beat later — "here's the thing / what do you think?" —
   * and we don't want to fire a reply to the photo before that lands.
   */
  bareAttachmentMs?: number;
  handler: BatchHandler;
  locks: SessionLocks;
  onError?: (err: unknown) => void;
};

function messageWindow(
  msg: InboundMessage,
  opts: { debounceMs: number; captionedAttachmentMs: number; bareAttachmentMs: number },
): number {
  if (msg.attachments.length === 0) return opts.debounceMs;
  const hasOwnText = (msg.text ?? "").trim().length > 0;
  return hasOwnText ? opts.captionedAttachmentMs : opts.bareAttachmentMs;
}

/**
 * Per-session batcher.
 *
 *  - Different sessions run in parallel (user ↔ contact A does not block
 *    user ↔ contact B).
 *  - Same session serializes via SessionLocks: no two Claude runs for the
 *    same thread simultaneously — they'd race on the same session UUID.
 *    The lock is shared with cron fires so scheduled events can't collide
 *    with inbound either.
 *  - Debounces within a session: messages landing close together flush to
 *    Claude as a single turn. The idle window resets on each new message
 *    (so a burst is held until the sender pauses), capped by `maxMs` from
 *    the first queued message. The window depends on the message:
 *      • plain text → `debounceMs`
 *      • attachment + caption text → `captionedAttachmentMs` (short; the
 *        message is self-contained, the user wants an answer)
 *      • bare attachment, no text → `bareAttachmentMs` (long; a caption /
 *        question almost always follows a beat later, and we don't want to
 *        answer the photo before it arrives)
 *  - The batch is snapshotted *after* the session lock is acquired, so a
 *    message that arrives while Claude is still mid-turn for this thread
 *    joins the next batch instead of spawning its own turn.
 */
export class SessionPipeline {
  private buckets = new Map<SessionKey, Bucket>();
  private debounceMs: number;
  private voiceDebounceMs: number;
  private maxMs: number;
  private captionedAttachmentMs: number;
  private bareAttachmentMs: number;
  private handler: BatchHandler;
  private locks: SessionLocks;
  private onError: (err: unknown) => void;

  constructor(params: PipelineOptions) {
    this.debounceMs = params.debounceMs;
    this.voiceDebounceMs = params.voiceDebounceMs ?? Math.min(params.debounceMs, 250);
    this.captionedAttachmentMs = params.captionedAttachmentMs ?? Math.min(params.debounceMs, 600);
    this.bareAttachmentMs = params.bareAttachmentMs ?? Math.max(params.debounceMs, 4000);
    // The cap must be able to span the longest single-message window plus a
    // little headroom for a follow-up, or a bare attachment would be cut off
    // before its caption arrives.
    this.maxMs = params.maxMs ?? Math.max(params.debounceMs, this.bareAttachmentMs + 4000);
    this.handler = params.handler;
    this.locks = params.locks;
    this.onError = params.onError ?? ((e) => console.error("[pipeline]", e));
  }

  enqueue(key: SessionKey, msg: InboundMessage): void {
    // Real work beats maintenance: if a deferred /compact is holding this
    // session's lock, tear it down now so this message isn't stuck behind
    // minutes of summarization (see channels/compact-gate.ts).
    abortActiveCompact(key);
    let b = this.buckets.get(key);
    if (!b) {
      b = { queue: [], timer: null, firstAt: null };
      this.buckets.set(key, b);
    }
    b.queue.push(msg);
    if (b.firstAt === null) b.firstAt = Date.now();

    if (this.debounceMs === 0) {
      if (b.timer) {
        clearTimeout(b.timer);
        b.timer = null;
      }
      this.flushLocked(key, b);
      return;
    }

    const elapsed = Date.now() - b.firstAt;
    const remainingToMax = Math.max(0, this.maxMs - elapsed);
    const wait = Math.min(this.windowFor(key, msg), remainingToMax);

    if (b.timer) clearTimeout(b.timer);
    if (wait <= 0) {
      b.timer = null;
      this.flushLocked(key, b);
    } else {
      b.timer = setTimeout(() => this.flushLocked(key, b!), wait);
    }
  }

  /**
   * How long this message should hold the batch open.
   *
   * Voice sessions get their own (much shorter) window. The typing debounce
   * exists to wait out a sender who is still composing; a mirror transcript
   * has already been endpointed by the mic's VAD, so waiting the full window
   * is silence the user hears as the assistant being slow to react. Messages
   * carrying attachments keep the normal windows even on a voice session —
   * those still want the "caption is probably coming" grace period.
   */
  private windowFor(key: SessionKey, msg: InboundMessage): number {
    if (isMirrorSession(key) && msg.attachments.length === 0) return this.voiceDebounceMs;
    return messageWindow(msg, {
      debounceMs: this.debounceMs,
      captionedAttachmentMs: this.captionedAttachmentMs,
      bareAttachmentMs: this.bareAttachmentMs,
    });
  }

  /** Messages queued for this session that have not flushed yet. The
   *  deferred compact checks this to yield to real work before starting. */
  queuedCount(key: SessionKey): number {
    return this.buckets.get(key)?.queue.length ?? 0;
  }

  /** Drop work that has not acquired the session lock yet. Active work is
   * cancelled separately through the session's AbortController. */
  cancelQueued(key: SessionKey): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const count = bucket.queue.length;
    bucket.queue.length = 0;
    bucket.firstAt = null;
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = null;
    return count;
  }

  private flushLocked(key: SessionKey, b: Bucket): void {
    b.timer = null;
    if (b.queue.length === 0) return;
    // Snapshot inside the lock: if the session is mid-turn, withLock
    // suspends here, and any messages that arrive while we wait land in
    // b.queue and get picked up by this same splice — no extra turn.
    this.locks
      .withLock(key, async () => {
        const batch = b.queue.splice(0);
        b.firstAt = null;
        if (batch.length === 0) return;
        await this.handler(key, batch);
      })
      .catch((err) => this.onError(err))
      .finally(() => {
        if (b.queue.length > 0 && b.timer === null) {
          if (b.firstAt === null) b.firstAt = Date.now();
          // Same voice/typing split as the initial enqueue — re-arming a
          // voice bucket on the typing window would put the delay back on
          // exactly the follow-up turns that need it least.
          const next = b.queue[0];
          const wait = next ? this.windowFor(key, next) : this.debounceMs;
          b.timer = setTimeout(() => this.flushLocked(key, b), wait);
        }
      });
  }
}
