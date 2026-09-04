import type { ChatDb } from "../imessage/db.ts";
import type { StateStore } from "../sessions/store.ts";
import { log } from "../util/log.ts";
import type { OperatorAlert } from "./operator-alert.ts";

/**
 * The "message could not be delivered" alert, deferred until it can be true.
 *
 * Send recovery gives up after its bounded rounds, but giving up there is not
 * the end of the message: the reply goes to the durable outbox, and the next
 * turn's drain or the recovery sweeper (first attempt lands within ~2.5
 * minutes) usually flushes it — every alert in the 12 hours before this module
 * existed was followed by a successful flush 17–120 seconds later. Alerting at
 * the moment recovery rounds run out therefore told the operator "was not
 * delivered" about messages that were delivered moments later.
 *
 * So the alert waits. When recovery reports an unrecovered send, a check is
 * scheduled one grace window out and answered from ground truth, not from the
 * send path's memory of failing:
 *
 *  - the outbox still holds a reply for that chat → still stuck, alert, with
 *    how long it has been queued;
 *  - otherwise, chat.db shows one of our messages landed in the intended chat
 *    after the failure → it recovered, say so in the log and stay quiet;
 *  - otherwise → nothing queued and nothing landed (a send path with no
 *    outbox behind it), alert.
 *
 * A daemon restart inside the grace window drops the pending check; the
 * sweeper's own stuck-session alerts still cover a message that stays lost.
 */

/** How long recovery (outbox drain, sweeper) gets before the operator hears.
 *  Covers the next-turn drain and the sweeper's first recovery attempt; a
 *  message still queued past this has failed both. */
const GRACE_MS = 5 * 60_000;

type UnrecoveredEvent = {
  guid: string;
  intended: string;
  landedChatGuid: string;
  landedIdentifier: string;
};

/** The handle a DM spec addresses ("any;-;+1555…" → "+1555…"), or null for
 *  group GUIDs and opaque identifiers, which address rooms, not people. */
function dmHandleOf(intended: string): string | null {
  const dm = intended.lastIndexOf(";-;");
  if (dm >= 0) return intended.slice(dm + 3) || null;
  return intended.includes(";") ? null : intended;
}

const LANDED_SINCE_SQL = `
  SELECT COUNT(*) AS n
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE m.is_from_me = 1
    AND ((m.date / 1000000) + 978307200000) >= ?
    AND (c.guid = ? OR (? != '' AND (c.chat_identifier = ? OR c.guid LIKE '%;-;' || ?)))
`;

export class UndeliveredAlert {
  /** One pending check per intended chat — a burst of failures for the same
   *  conversation answers once, from the earliest failure's timestamp. */
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private deps: {
      alert: OperatorAlert;
      state: StateStore;
      chatDb: ChatDb;
      graceMs?: number;
    },
  ) {}

  /** Call when send recovery has exhausted its rounds. Schedules the
   *  ground-truth check instead of alerting immediately. */
  report(event: UnrecoveredEvent, nowMs = Date.now()): void {
    if (this.pending.has(event.intended)) return;
    const graceMs = this.deps.graceMs ?? GRACE_MS;
    log.warn("send-verify", "unrecovered send parked with the outbox — alert deferred", {
      intended: event.intended,
      recheck_in_s: Math.round(graceMs / 1000),
    });
    const timer = setTimeout(() => {
      this.pending.delete(event.intended);
      this.check(event, nowMs).catch((err) => {
        log.error("send-verify", "deferred undelivered check failed", {
          intended: event.intended,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }, graceMs);
    timer.unref?.();
    this.pending.set(event.intended, timer);
  }

  /** Exposed for tests; production reaches it through report()'s timer. */
  async check(event: UnrecoveredEvent, failedAtMs: number): Promise<void> {
    const stuck = this.deps.state.getOutboxByChatGuid(event.intended);
    if (stuck) {
      await this.deps.alert.notify({
        category: "message could not be delivered",
        error:
          `${event.intended} kept routing to our own thread; a reply has been stuck in the ` +
          `outbox for ${Math.round((Date.now() - stuck.firstFailedMs) / 1000)}s ` +
          `(${stuck.attemptCount} attempts) — the sweeper keeps retrying`,
        context: {
          session: stuck.sessionKey,
          ...(event.landedChatGuid ? { landed_chat: event.landedChatGuid } : {}),
        },
      });
      return;
    }

    if (this.landedSince(event.intended, failedAtMs)) {
      log.info("send-verify", "undelivered alert suppressed — message landed after recovery", {
        intended: event.intended,
        checked_after_s: Math.round((Date.now() - failedAtMs) / 1000),
      });
      return;
    }

    // Nothing queued and nothing landed: a send with no outbox behind it
    // (cron delivery, tool send) genuinely did not go.
    await this.deps.alert.notify({
      category: "message could not be delivered",
      error: `${event.intended} kept routing to our own thread; ${event.guid} was not delivered`,
      context: event.landedChatGuid ? { landed_chat: event.landedChatGuid } : undefined,
    });
  }

  /** Did one of our messages land in the intended chat after the failure? */
  private landedSince(intended: string, sinceMs: number): boolean {
    const handle = dmHandleOf(intended) ?? "";
    const row = this.deps.chatDb
      .query<{ n: number }>(LANDED_SINCE_SQL)
      .get(sinceMs, intended, handle, handle, handle) as { n: number } | null | undefined;
    return (row?.n ?? 0) > 0;
  }
}
