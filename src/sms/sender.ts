import type { Config } from "../config/config.ts";
import { normalizeHandle } from "../sessions/key.ts";
import { log } from "../util/log.ts";
import { TWILIO_STOP_ERROR, type TwilioCreds, sendConversationMessage, sendSms } from "./client.ts";
import { estimateOutboundUsd } from "./costs.ts";
import { chunkForSms, segmentCount, toGsm7 } from "./segment.ts";
import { isSmsChatGuid } from "./session.ts";
import { SmsStore } from "./store.ts";

/**
 * Outbound-only half of the SMS channel.
 *
 * Split out of `channel.ts` so a process that has credentials but no
 * pipeline can still address a conversation. That is not hypothetical: the
 * MCP server runs as its own stdio subprocess, so the deliverer that
 * `channels/deliver.ts` holds in a module-level variable does not exist
 * there, and `send_message` used to fall through to the iMessage send path
 * and fail with `chat_not_found` on a Conversation SID. Sending is the whole
 * dependency — creds, config, the store — so it is the part that travels.
 *
 * `createSmsChannel` builds one of these and exposes its `deliver` as the
 * registered deliverer, so both processes run the same code: one consent
 * check, one chunker, one ledger write.
 */

export type SmsChannelDelivery = {
  sent: number;
  sentChunks: string[];
  errors: string[];
  silenced: boolean;
};

export type SmsSenderOpts = {
  config: Config;
  creds: TwilioCreds;
  /** Our own sending number, E.164 — the author on group Conversation posts. */
  ownNumber: string;
  statusCallbackUrl?: string;
  /** Reuse the channel's open store; omit to open one from `dataDir`. */
  store?: SmsStore;
  dataDir?: string;
};

export type SmsSender = {
  store: SmsStore;
  /** Route by chat guid: `sms:CH…` is a room, `sms:+1…` is a person. */
  deliver: (args: {
    chatGuid: string;
    isGroup: boolean;
    text: string;
  }) => Promise<SmsChannelDelivery>;
};

export function createSmsSender(opts: SmsSenderOpts): SmsSender {
  const { config, creds } = opts;
  const sms = config.sms;
  const store =
    opts.store ??
    new SmsStore(
      opts.dataDir ??
        (() => {
          throw new Error("createSmsSender needs a store or a dataDir");
        })(),
    );

  /** One DM body over the Messages API, with consent enforced HERE — the last
   *  gate before money and reach. */
  const sendDm = async (to: string, body: string): Promise<SmsChannelDelivery> => {
    const consent = store.checkConsent(to);
    if (!consent.allowed) {
      return {
        sent: 0,
        sentChunks: [],
        errors: [`recipient opted out (${new Date(consent.sinceMs).toISOString()})`],
        silenced: false,
      };
    }
    const prepared = sms.normalize_to_gsm7 ? toGsm7(body) : body;
    const chunks = chunkForSms(prepared, {
      maxSegments: sms.max_segments_per_message,
      maxParts: sms.max_parts,
    });
    const sentChunks: string[] = [];
    const errors: string[] = [];
    for (const chunk of chunks) {
      const res = await sendSms({
        creds,
        to,
        body: chunk,
        messagingServiceSid: sms.messaging_service_sid,
        from: sms.messaging_service_sid ? undefined : sms.from,
        statusCallback: opts.statusCallbackUrl,
      });
      if (res.ok) {
        sentChunks.push(chunk);
        const segments = segmentCount(chunk);
        store.record({
          conversation: normalizeHandle(to),
          direction: "out",
          body: chunk,
          messageSid: res.sid,
        });
        // Live ledger row with the estimate; the reconciler sweep replaces it
        // with Twilio's posted price and forwards the actual to spend.db.
        const estUsd = estimateOutboundUsd(segments);
        store.recordSpend({
          messageSid: res.sid,
          direction: "out",
          counterparty: to,
          segments,
          estUsd,
        });
        log.info("sms", "sent", { to, sid: res.sid, segments, est: `$${estUsd.toFixed(4)}` });
      } else {
        errors.push(res.error);
        // 21610 is consent state wearing an error code: Twilio refused on the
        // recipient's behalf. Record it so the harness stops asking.
        if (res.code === TWILIO_STOP_ERROR) store.setOptedOut(to, "STOP(21610)");
        break;
      }
    }
    return { sent: sentChunks.length, sentChunks, errors, silenced: false };
  };

  /** One group reply, posted into the Conversation. No per-member consent
   *  check — the room is the addressee, and Twilio suppresses delivery to any
   *  member who opted out of the number pair. */
  const sendGroup = async (conversationSid: string, body: string): Promise<SmsChannelDelivery> => {
    const prepared = sms.normalize_to_gsm7 ? toGsm7(body) : body;
    const chunks = chunkForSms(prepared, {
      maxSegments: sms.max_segments_per_message,
      maxParts: sms.max_parts,
    });
    const sentChunks: string[] = [];
    const errors: string[] = [];
    for (const chunk of chunks) {
      const res = await sendConversationMessage({
        creds,
        conversationSid,
        body: chunk,
        author: opts.ownNumber,
      });
      if (res.ok) {
        sentChunks.push(chunk);
        store.record({
          conversation: conversationSid,
          direction: "out",
          body: chunk,
          messageSid: res.sid,
        });
        const members = store.groupInfo(conversationSid)?.participants.length ?? 1;
        // Estimate only: one Conversations message fans out to N billable
        // per-recipient sends whose SIDs surface later; the sweep ledgers them.
        log.info("sms", "group sent", {
          conversationSid,
          sid: res.sid,
          recipients: members,
          est: `$${(estimateOutboundUsd(segmentCount(chunk)) * members).toFixed(4)}`,
        });
      } else {
        errors.push(res.error);
        break;
      }
    }
    return { sent: sentChunks.length, sentChunks, errors, silenced: false };
  };

  const deliver = async (args: {
    chatGuid: string;
    isGroup: boolean;
    text: string;
  }): Promise<SmsChannelDelivery> => {
    if (!isSmsChatGuid(args.chatGuid)) {
      return {
        sent: 0,
        sentChunks: [],
        errors: [`not an sms chat guid: ${args.chatGuid}`],
        silenced: false,
      };
    }
    const conversationId = args.chatGuid.slice("sms:".length);
    if (conversationId.startsWith("CH")) return sendGroup(conversationId, args.text);
    return sendDm(conversationId, args.text);
  };

  return { store, deliver };
}
