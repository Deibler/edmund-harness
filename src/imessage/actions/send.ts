import { randomUUID } from "node:crypto";

import type { SendOptions } from "imcore-bridge";

import { log } from "../../util/log.ts";
import { invoke } from "../bridge/index.ts";
import type { SendResult } from "../types.ts";
import { describeError, isTransient } from "./classify.ts";
import { effectId } from "./effects.ts";
import { chatTarget } from "./target.ts";
import { recoveryWaitMs, verifyDelivery } from "./verify.ts";

export interface SendArgs {
  /** For DMs: phone or Apple ID. For groups: the chat GUID. */
  to: string;
  isGroup: boolean;
  text?: string;
  attachments?: string[];
  /** Stable chat GUID from chat.db, preferred when the caller has it. */
  chatGuid?: string;
  /** Message GUID to reply to — native inline threading. */
  replyTo?: string;
  /** Expressive-send effect id. */
  effect?: string;
  /** Bold subject-line header above the body. */
  subject?: string;
}

/** Attempts, and the delay before each retry. */
const BACKOFF_MS = [250, 750, 2_000];

/**
 * Sends one message, and says plainly whether it went.
 *
 * Text and attachments travel together, so a caption arrives as part of the
 * message rather than as a second bubble behind it.
 *
 * Retries are bounded and safe rather than hopeful. Every attempt carries the
 * same idempotency key, so a send that reached Messages and lost its reply — the
 * case that used to produce a duplicate bubble — comes back as `duplicate` on
 * the retry instead of going out twice. That replaces reading chat.db and
 * matching on the message text to guess whether the first attempt landed.
 *
 * Only conditions that may clear are retried, decided from the error's type.
 * Nothing here falls back to another way of sending: if the message cannot be
 * delivered, the caller is told.
 */
export async function sendMessage(args: SendArgs): Promise<SendResult> {
  const text = args.text ?? "";
  const files = args.attachments ?? [];
  if (!text.trim() && files.length === 0) return { ok: false, error: "empty message" };

  // The model writes short names ("confetti"); IMCore wants the full identifier.
  // An unrecognised name drops off rather than failing the send, which is what
  // the old path did when the CLI rejected one.
  const effect = effectId(args.effect);

  const options: SendOptions = {
    chat: chatTarget(args),
    ...(text ? { text } : {}),
    ...(files.length ? { files } : {}),
    ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    ...(effect ? { effect } : {}),
    ...(args.subject ? { subject: args.subject } : {}),
    // NEVER a `service`. A message goes however its conversation already
    // sends. Naming a service invoked sendMessage:onAccount: whenever the
    // chat's binding disagreed — the call that re-registers the chat against
    // our own account inside imagent and turns it into a note-to-self route.
    // SendArgs deliberately has no service field so no caller can reintroduce
    // the poisoner.
    // One key per message we mean to send, reused across every retry of it.
    idempotencyKey: randomUUID(),
  };

  let lastError = "unknown";

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    try {
      const result = await invoke("send", options);
      if (attempt > 0) {
        log.info("send", "delivered on retry", {
          attempt: attempt + 1,
          duplicate: result.duplicate === true,
        });
      }
      return await confirmLanding(result, options);
    } catch (error) {
      lastError = describeError(error);

      // The injected block refused this send before it could leave — the
      // chat resolved to something that is not the conversation addressed.
      // Nothing landed in the self thread, so this is the cleanest possible
      // signal: retry briefly, then hand the reply to the durable outbox.
      const refusalCode = selfRouteRefusalCode(error);
      if (refusalCode) {
        // The bridge does not just say "no": IMBChatMatchesSpec builds a
        // sentence naming the identifier, participant and recipient it
        // actually resolved, and the cure. That sentence is the only
        // first-hand account of WHY the registry was judged wrong, and it
        // was being dropped here — every downstream line reduced it to the
        // canned `refused before send (chat_mismatch)`, which is why a month
        // of these logs could not distinguish a genuinely poisoned registry
        // from an over-strict guard. Record it where it is still intact.
        log.warn("send-verify", "refused before send — resolution invariant failed", {
          intended: String(options.chat),
          code: refusalCode,
          detail: error instanceof Error ? error.message : String(error),
        });
        return recoverFromSelfRoute(options, {
          guid: "(refused before send)",
          intended: String(options.chat),
          landedChatGuid: "",
          landedIdentifier: `refused before send (${refusalCode})`,
        });
      }

      if (!isTransient(error)) return { ok: false, error: lastError };

      if (attempt === BACKOFF_MS.length) break;
      const delay = BACKOFF_MS[attempt]!;
      log.warn("send", "attempt failed, retrying", {
        attempt: attempt + 1,
        in_ms: delay,
        err: lastError,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { ok: false, error: `after ${BACKOFF_MS.length + 1} attempts: ${lastError}` };
}

/** Bridge error codes that mean "the registry resolved this chat wrongly" —
 *  a send refused before it could leak. chat_mismatch is the resolution
 *  invariant (added with the removal of account forcing): the resolved chat
 *  is not the conversation the spec addressed, which includes the poison
 *  shape where the object has been fully relabelled with our own identity. */
function selfRouteRefusalCode(error: unknown): string | null {
  const code = (error as { code?: string } | null)?.code;
  return code === "self_send_blocked" || code === "chat_poisoned" || code === "chat_mismatch"
    ? code
    : null;
}

/**
 * Confirms against chat.db that the send landed where it was addressed.
 *
 * The registry has been observed routing a GUID-addressed send into the
 * note-to-self thread while answering success, so "the bridge said sent" is
 * not the end of a send — the store is. A landing in our own thread enters the
 * same recovery a pre-send refusal does.
 */
async function confirmLanding(
  result: { guid: string; recipient?: string },
  options: SendOptions,
): Promise<SendResult> {
  const intended = String(options.chat);
  const outcome = await verifyDelivery(result.guid, intended);
  if (outcome.verdict !== "misdelivered") return { ok: true };

  log.error("send-verify", "send landed in our own thread", {
    guid: result.guid,
    intended,
    landed: outcome.event.landedIdentifier,
    routed_recipient: result.recipient ?? "unknown",
  });
  return recoverFromSelfRoute(options, outcome.event);
}

/**
 * Quick resends before handing the reply to the outbox.
 *
 * Deliberately few. This used to escalate to a "registry heal" — relaunching
 * the user's Messages.app, globally debounced to once per 5 minutes. Measured
 * over 181 relaunches, that fixed the chat 25% of the time, and its debounce
 * was implicated in every single one of the 159 sends declared lost (a heal
 * had been throttled within 90s of all of them). It was doing more harm than
 * the failure it chased, so it is gone from the send path.
 *
 * What replaces it is patience in the right place: the drainer retries the
 * queued reply every 10s for as long as it takes. The send path only needs to
 * cover the flicker that clears in seconds, and to get out of the way.
 */
const SOFT_ROUNDS = 2;

/**
 * Ceiling for one recovery wait. The whole in-send recovery is now bounded at
 * roughly 2.5 + 5 ≈ 8s, because the durable retry moved to the drainer.
 *
 * Why this is not a flat wait any more. Every round used to wait the same
 * 2.5s, so the entire recovery gave up inside ~10s. But the outbox — which
 * picks up exactly the sends this gave up on — flushes them successfully,
 * and the measured queue times on 2026-08-27 were 34s, 129s and 3384s. A
 * message that flushes at 34s was never unrecoverable; the window just
 * closed while imagent was still poisoned. That is what produced ~1/3 of
 * self-routes going "unrecovered" and alerting the operator about sends
 * that then arrived minutes later on their own.
 */
const MAX_RECOVERY_WAIT_MS = 30_000;

/** Backoff for attempt N (0-indexed), doubling from the configured base. */
function recoveryBackoffMs(attempt: number): number {
  return Math.min(recoveryWaitMs() * 2 ** attempt, MAX_RECOVERY_WAIT_MS);
}

/** Sends under a fresh key and returns whether it landed off our own thread.
 *  A refusal (block armed) counts as not-landed without throwing. */
async function resendAndCheck(options: SendOptions, intended: string): Promise<boolean> {
  try {
    const retry = await invoke("send", { ...options, idempotencyKey: randomUUID() });
    const verdict = await verifyDelivery(retry.guid, intended);
    return verdict.verdict !== "misdelivered";
  } catch (error) {
    if (selfRouteRefusalCode(error)) return false;
    throw error;
  }
}

/**
 * Recovers a send whose chat routes to our own address, whether the injected
 * block refused it up front or chat.db caught it after the fact.
 *
 * The corruption lives in imagent's identity cache and clears on its own on a
 * timescale of seconds to minutes, so recovery starts gently: a couple of
 * plain resends after a short wait, no bounce. Most flickers clear here, which
 * is why the user does not see Messages restart for them. Only a poison that
 * survives the soft rounds escalates to a registry rebuild. If every round
 * fails, the message is genuinely lost, and only then is the operator told —
 * a self-route that recovered got the recipient their message and needs no
 * alert.
 *
 * A process with no handler (the post-tool hook) cannot heal, so it fails on
 * the first detection rather than looping to no effect.
 */
async function recoverFromSelfRoute(
  options: SendOptions,
  event: { guid: string; intended: string; landedChatGuid: string; landedIdentifier: string },
): Promise<SendResult> {
  try {
    for (let round = 0; round < SOFT_ROUNDS; round += 1) {
      await new Promise((r) => setTimeout(r, recoveryBackoffMs(round)));
      if (await resendAndCheck(options, event.intended)) {
        log.info("send-verify", "self-route cleared on its own, resend landed", {
          intended: event.intended,
          soft_round: round + 1,
        });
        return { ok: true };
      }
    }
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  // Out of quick retries. NOT "the message is lost" — it goes to the durable
  // outbox, which the drainer retries every 10s for as long as it takes. The
  // operator hears nothing, because nothing has been lost yet.
  return {
    ok: false,
    error: `SelfRouteTransientError[self_route_retrying]: chat still routing to self after ${SOFT_ROUNDS} attempts — queued`,
  };
}
