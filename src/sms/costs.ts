import { recordSpend } from "../spend/ledger.ts";
import { log } from "../util/log.ts";
import type { TwilioCreds } from "./client.ts";
import type { SmsStore } from "./store.ts";

/**
 * SMS cost tracking — a live estimate at event time, reconciled against
 * Twilio's own billing records afterward.
 *
 * Twilio finalizes a message's `price` minutes to hours after the event, so
 * anything logged at send time is necessarily an estimate. Rather than
 * pretend otherwise, the ledger holds both columns: `est_usd` written the
 * moment we act, `actual_usd` filled by `reconcileSmsCosts` once Twilio has
 * posted it. The shared spend.db (whose contract is "record, never
 * estimate") receives a row only at reconciliation, with the actual figure.
 *
 * The reconciler sweeps Twilio's message list rather than chasing SIDs we
 * remember, for one structural reason: a group reply is ONE Conversations
 * message on our side but N per-recipient deliveries on Twilio's, and we
 * never see the children's SIDs. Sweeping the list catches them — the ledger
 * is derived from the billing system of record, not from what we think we
 * sent.
 *
 * Rate-card constants are provisional by design (reconciliation replaces
 * them); they exist so the live log line can say roughly what an action cost
 * without waiting hours.
 */

/** Twilio US SMS outbound per segment + typical carrier passthrough. */
const EST_OUT_SMS_SEGMENT = 0.0079 + 0.003;
/** Inbound SMS. */
const EST_IN_SMS = 0.0075;
/** Inbound MMS (how group-text messages arrive) + carrier fee. */
const EST_IN_MMS = 0.01 + 0.005;

export function estimateOutboundUsd(segments: number): number {
  return Math.max(1, segments) * EST_OUT_SMS_SEGMENT;
}

export function estimateInboundUsd(kind: "sms" | "mms"): number {
  return kind === "mms" ? EST_IN_MMS : EST_IN_SMS;
}

/** Billing kind from a REAL Twilio Messages SID (MM = MMS, SM = SMS). Only
 *  valid for Messages-API records — a Conversations webhook's IM… sid says
 *  nothing about billing and must not be sniffed. */
export function kindFromMessagesSid(sid: string): "sms" | "mms" {
  return sid.startsWith("MM") ? "mms" : "sms";
}

/**
 * Sweep Twilio's message list and true-up the ledger.
 *
 * - Fills `actual_usd` on rows whose price has posted (Twilio reports the
 *   price as a NEGATIVE string, e.g. "-0.00790" — the sign is dropped).
 * - Inserts rows for messages we never recorded (group fan-out children).
 * - On each first reconciliation, appends the actual cost to spend.db under
 *   subsystem "sms" so the dashboard's spend view includes the channel.
 *
 * Returns counts so the caller's log line can say what happened.
 */
export async function reconcileSmsCosts(params: {
  creds: TwilioCreds;
  store: SmsStore;
  dataDir: string;
  ownNumber: string;
  /** Look this far back for messages (ms). Default 48h. */
  windowMs?: number;
}): Promise<{ reconciled: number; discovered: number; pendingPrice: number } | null> {
  const { creds, store, dataDir } = params;
  const sinceMs = Date.now() - (params.windowMs ?? 48 * 3_600_000);
  const dateSent = new Date(sinceMs).toISOString().slice(0, 10);
  const url =
    `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json` +
    `?PageSize=200&DateSent%3E=${dateSent}`;
  let json: {
    messages?: {
      sid: string;
      direction: string;
      from: string;
      to: string;
      price: string | null;
      num_segments: string;
      date_created: string;
      status: string;
    }[];
  };
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.keySid}:${creds.keySecret}`).toString("base64")}`,
      },
    });
    if (!res.ok) {
      log.warn("sms", "cost sweep fetch failed", { status: res.status });
      return null;
    }
    json = (await res.json()) as typeof json;
  } catch (err) {
    log.warn("sms", "cost sweep error", { err: String(err) });
    return null;
  }

  let reconciled = 0;
  let discovered = 0;
  let pendingPrice = 0;
  for (const m of json.messages ?? []) {
    const inbound = m.direction.startsWith("inbound");
    const counterparty = inbound ? m.from : m.to;
    const atMs = Date.parse(m.date_created) || Date.now();
    const segments = Number.parseInt(m.num_segments, 10) || 1;
    const known = store.spendRow(m.sid);
    if (!known) {
      // A message the channel never recorded first-hand — most often a group
      // fan-out child, sometimes an out-of-band console send.
      store.recordSpend({
        messageSid: m.sid,
        direction: inbound ? "in" : "out",
        counterparty,
        segments,
        estUsd: inbound
          ? estimateInboundUsd(kindFromMessagesSid(m.sid))
          : estimateOutboundUsd(segments),
        atMs,
      });
      discovered++;
    }
    if (m.price == null) {
      if (!known?.actualUsd) pendingPrice++;
      continue;
    }
    const actual = Math.abs(Number.parseFloat(m.price));
    if (!Number.isFinite(actual)) continue;
    if (known?.actualUsd == null) {
      store.reconcileSpend(m.sid, actual);
      // First time this message's true cost is known — hand it to the shared
      // ledger, which records actuals only.
      recordSpend(dataDir, {
        sessionKey: `sms:dm:${counterparty}`,
        subsystem: "sms",
        costUsd: actual,
      });
      reconciled++;
    }
  }
  return { reconciled, discovered, pendingPrice };
}
