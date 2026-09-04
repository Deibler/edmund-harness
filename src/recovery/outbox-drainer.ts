import { deliverReply } from "../channels/deliver.ts";
import type { Config } from "../config/config.ts";
import { unrecoveredHandler } from "../imessage/actions/verify.ts";
import type { ChatDb } from "../imessage/db.ts";
import { isPermanentSendError } from "../imessage/send.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import type { EchoCache } from "../sessions/echo-cache.ts";
import { type SessionKey, chatIdFromKey, isGroupSession } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import type { StateStore } from "../sessions/store.ts";
import { log } from "../util/log.ts";

/**
 * Delivers queued replies on their own clock.
 *
 * A reply that failed to send used to leave the outbox only when a TURN ran
 * for its session — a new inbound, or the 60s recovery sweep. So a message
 * Edmund had already written sat undelivered until the person wrote again,
 * and then arrived stacked on top of the thing they had just asked, reading
 * as an answer to it. Delivery is not a conversational event and should not
 * wait for one.
 *
 * This drains independently and often, so a reply blocked by a transient
 * routing failure goes out seconds later, on its own, in its own turn's
 * place — and the next inbound finds an empty queue.
 *
 * Deliberately does no model work. It re-sends text that was already
 * composed; there is nothing to think about, and a drain must never be able
 * to cost a model invocation.
 */

/** How often to try the queue. Short: the failures this clears are transient. */
export const DRAIN_INTERVAL_MS = 10_000;

/**
 * How long a reply may sit before the operator is told.
 *
 * The alert used to fire the moment the send path ran out of rounds — about
 * ten seconds in — which announced "message could not be delivered" for
 * messages that then arrived by themselves. Nothing is lost while the drainer
 * still has it, so the honest threshold is "we have been retrying for a long
 * time and it is still not going", not "the first attempts failed".
 */
export const STUCK_ALERT_AFTER_MS = 10 * 60_000;

/**
 * Ceiling on the gap between retries for one stuck reply.
 *
 * The first version retried every 10s flat, forever. Against a genuinely
 * poisoned chat that is 8,640 pointless sends a day — 2,358 had already been
 * burned on one conversation before this was added. Fast while a failure
 * might be a blip, patient once it plainly is not.
 */
export const MAX_DRAIN_BACKOFF_MS = 5 * 60_000;

/**
 * How long a reply sits failing before we try rebuilding the chat registry.
 *
 * A registry heal relaunches Messages.app, and it used to run from the SEND
 * path on every transient blip — which made it both useless and harmful (it
 * fixed the chat 25% of the time, and its 5-minute debounce starved every
 * other recovery). It is still the only cure the harness has for a chat whose
 * registry object has been relabelled with our own address, so it belongs
 * here instead: once per stuck episode, after the evidence says persistent
 * rather than transient.
 */
export const HEAL_ESCALATE_AFTER_MS = 2 * 60_000;

/** Sessions already reported stuck, so one bad chat alerts once, not every tick. */
const alerted = new Set<SessionKey>();

/** Earliest next attempt per session — the backoff schedule. */
const nextTryAt = new Map<SessionKey, number>();

/** Sessions we have already tried to heal this episode. One relaunch, not one per tick. */
const healAttempted = new Set<SessionKey>();

/** Forget every per-episode fact about a session that just succeeded or was dropped. */
function resetEpisode(key: SessionKey): void {
  nextTryAt.delete(key);
  healAttempted.delete(key);
  alerted.delete(key);
}

/**
 * Clears all per-episode state. The backoff, heal and alert bookkeeping is
 * module-level because it belongs to the running daemon rather than to any
 * one call — which means a test that does not clear it inherits the previous
 * test's backoff and silently observes no attempt at all.
 */
export function resetDrainState(): void {
  nextTryAt.clear();
  healAttempted.clear();
  alerted.clear();
  inFlight.clear();
}

/**
 * Sessions being drained right now.
 *
 * `channels/turn.ts` still flushes the outbox at the top of a turn (it needs
 * to, so a flushed reply becomes the model's prior assistant turn before it
 * answers anything new). That leaves a narrow window where both could send
 * the same text. This closes it on the drainer's side; a turn that wins the
 * race clears the row and the drainer's next pass simply finds nothing.
 */
const inFlight = new Set<SessionKey>();

export type DrainDeps = {
  state: StateStore;
  config: Config;
  echoes: EchoCache;
  /** chat.db + contacts, so a row queued without a chat row can be pinned to
   *  one before it is retried. Optional only so tests need not build them. */
  chatDb?: ChatDb;
  contacts?: ContactBook;
  /** Delivery function, injectable so a test can supply its own without
   *  mock.module — which would replace deliverReply for the whole test run
   *  and break everything that exercises the real one. */
  deliver?: typeof deliverReply;
  /** Registry heal, injectable so tests never relaunch the real Messages.app. */
  heal?: (reason: string) => Promise<unknown>;
};

export type DrainResult = { attempted: number; sent: number; dropped: number };

/**
 * The chat row to address this queued reply to, resolving one if the row has none.
 *
 * A reply is queued by whichever send path failed, carrying whatever that path
 * knew. Some knew no chat GUID, so the row stored `''` — and the drainer then
 * retried it by bare handle, over and over, because `chatTarget` falls back to
 * the handle when no GUID is given.
 *
 * That is the one thing this account cannot survive. With no phone number on
 * the Apple ID, IMCore resolves a bare handle onto the note-to-self thread, the
 * bridge refuses it as `chat_mismatch`, and the attempt relabels the registry's
 * chat object with our own address on the way past. So the retry loop was not
 * merely failing to deliver — it was re-inflicting the corruption it was
 * retrying because of, once every ten seconds. One conversation took 67 of
 * those in eleven minutes.
 *
 * chat.db still holds the right answer the whole time; nobody was asking it.
 */
function pinChatGuid(
  entry: { sessionKey: SessionKey; chatGuid: string },
  deps: DrainDeps,
): string {
  if (entry.chatGuid) return entry.chatGuid;
  if (!deps.chatDb || !deps.contacts) return "";
  try {
    const guid = chatGuidsForSession(entry.sessionKey, deps.chatDb, deps.contacts)[0];
    if (!guid) return "";
    // Persist it: the next drain, and any turn that flushes this row, then
    // start from a pinned address instead of rediscovering it.
    deps.state.setOutboxChatGuid(entry.sessionKey, guid);
    log.info("outbox-drain", "pinned a queued reply to its chat row", {
      session: entry.sessionKey,
      chat: guid,
    });
    return guid;
  } catch (err) {
    log.warn("outbox-drain", "could not resolve a chat row for a queued reply", {
      session: entry.sessionKey,
      err: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

/** One pass over the queue. Per-entry errors are isolated. */
export async function drainOutbox(deps: DrainDeps): Promise<DrainResult> {
  const result: DrainResult = { attempted: 0, sent: 0, dropped: 0 };

  const now = Date.now();
  for (const entry of deps.state.listOutbox()) {
    const key = entry.sessionKey;
    if (inFlight.has(key)) continue;
    // Backoff: a reply that keeps failing is retried less and less often.
    if ((nextTryAt.get(key) ?? 0) > now) continue;
    inFlight.add(key);
    result.attempted += 1;
    try {
      const chatGuid = pinChatGuid(entry, deps);
      if (!chatGuid && !isGroupSession(key)) {
        // Nothing in chat.db matches this session, so the only way to send is
        // the bare handle that causes the failure. Say so plainly rather than
        // burning another guaranteed refusal on it; the backoff below still
        // spaces the next look-up out.
        log.warn("outbox-drain", "queued reply has no chat row to send to", {
          session: key,
          queued_s: Math.round((Date.now() - entry.firstFailedMs) / 1000),
        });
      }
      const send = deps.deliver ?? deliverReply;
      const flush = await send(
        {
          to: entry.isGroup === 1 ? chatGuid : chatIdFromKey(key),
          isGroup: entry.isGroup === 1,
          text: entry.replyText,
          chatGuid,
        },
        deps.config,
        deps.echoes,
      );

      if (flush.sent > 0) {
        deps.state.clearOutbox(key);
        deps.state.clearError(key);
        result.sent += 1;
        resetEpisode(key);
        log.info("outbox-drain", "queued reply delivered", {
          session: key,
          queued_s: Math.round((Date.now() - entry.firstFailedMs) / 1000),
          attempts: entry.attemptCount,
        });
        continue;
      }

      // A content error fails identically forever — holding it just means
      // retrying it every tick until the row ages out. Drop it and say so;
      // the recovery sweeper still owns telling the model its reply was lost.
      if (flush.errors.length > 0 && flush.errors.every((e) => isPermanentSendError(e))) {
        deps.state.clearOutbox(key);
        result.dropped += 1;
        resetEpisode(key);
        log.warn("outbox-drain", "dropped a permanently undeliverable reply", {
          session: key,
          errors: flush.errors.slice(0, 2),
        });
        continue;
      }
      // Still transient. Leave it queued, but slow down and escalate by age.
      // Count the attempt FIRST: the backoff is computed from attempt_count,
      // and while only putOutbox incremented it the count never moved during
      // a retry loop, so every backoff came out the same size and the
      // "exponential" schedule was a flat one.
      deps.state.bumpOutboxAttempt(key);
      const queuedMs = Date.now() - entry.firstFailedMs;
      const backoff = Math.min(
        DRAIN_INTERVAL_MS * 2 ** Math.min(entry.attemptCount, 6),
        MAX_DRAIN_BACKOFF_MS,
      );
      nextTryAt.set(key, Date.now() + backoff);

      // Persistent, not a blip: try rebuilding the registry once. This is the
      // only cure for a chat object relabelled with our own address, which is
      // what the refusal detail reports when it names our own handle as the
      // identifier, participant AND recipient.
      if (queuedMs >= HEAL_ESCALATE_AFTER_MS && !healAttempted.has(key)) {
        healAttempted.add(key);
        log.warn("outbox-drain", "reply stuck — asking for one registry rebuild", {
          session: key,
          queued_s: Math.round(queuedMs / 1000),
        });
        // Imported lazily: the bridge module owns the Messages supervisor and
        // pulls the native addon in with it. A static import here put all of
        // that into the recovery module graph, which is enough to slow the
        // timing-sensitive watcher suites into failing under a full run.
        void (
          deps.heal ??
          ((reason: string) =>
            import("../imessage/bridge/index.ts").then((m) => m.healMessagingRegistry(reason)))
        )(`outbox stuck: ${key}`);
      }

      if (queuedMs >= STUCK_ALERT_AFTER_MS && !alerted.has(key)) {
        alerted.add(key);
        unrecoveredHandler()?.({
          guid: "(queued)",
          intended: entry.chatGuid,
          landedChatGuid: "",
          landedIdentifier: `still queued after ${Math.round(queuedMs / 60_000)}m`,
        });
      }
    } catch (err) {
      log.warn("outbox-drain", "drain attempt threw", {
        session: key,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight.delete(key);
    }
  }

  return result;
}

/** Starts the drain loop. Returns the timer so the caller can clear it. */
export function startOutboxDrainer(deps: DrainDeps): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void drainOutbox(deps).catch((err) =>
      log.warn("outbox-drain", "drain pass failed", {
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }, DRAIN_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
