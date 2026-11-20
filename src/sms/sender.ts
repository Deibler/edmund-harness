import type { Config } from "../config/config.ts";
import { normalizeHandle } from "../sessions/key.ts";
import { log } from "../util/log.ts";
import { TWILIO_STOP_ERROR, type TwilioCreds, sendConversationMessage, sendSms } from "./client.ts";
import { estimateGroupOutboundUsd, estimateOutboundUsd } from "./costs.ts";
import {
  type ConversationMediaApi,
  mediaNoun,
  prepareForMms,
  sdkConversationMediaApi,
  uploadMedia,
} from "./media.ts";
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

/**
 * Twilio's ceiling on a Conversations message body ("can be up to 1,600
 * characters long", Conversation Message resource docs). A group reply
 * splits only here: it is MMS, billed flat per recipient per message, so
 * every extra part is another full charge to every member of the room.
 */
export const GROUP_MESSAGE_MAX_CHARS = 1600;

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
  /** Conversations calls for media sends. Defaults to the Twilio SDK. */
  mediaApi?: ConversationMediaApi;
};

export type SmsMediaDelivery =
  | {
      ok: true;
      /** The file actually sent, when it was converted first (HEIC → JPEG, a shrunk video). */
      sentPath: string;
      converted: boolean;
    }
  | { ok: false; error: string };

export type SmsSender = {
  store: SmsStore;
  /** Route by chat guid: `sms:CH…` is a room, `sms:+1…` is a person. */
  deliver: (args: {
    chatGuid: string;
    isGroup: boolean;
    text: string;
  }) => Promise<SmsChannelDelivery>;
  /** Send one file as MMS into the conversation, with an optional caption. */
  deliverMedia: (args: {
    chatGuid: string;
    path: string;
    caption?: string;
  }) => Promise<SmsMediaDelivery>;
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
      budget: GROUP_MESSAGE_MAX_CHARS,
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
          est: `$${estimateGroupOutboundUsd(members).toFixed(4)}`,
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

  /**
   * One file into a conversation, as MMS: upload it to the Conversation's
   * Media Content Service, then post a message carrying its MediaSid.
   *
   * Both rooms and DMs go through their Conversation. The Messages API
   * would need the file at a public URL for Twilio to fetch, and these are
   * people's photos; an upload to MCS is visible to nobody but the
   * conversation. A DM therefore needs the Conversation the person's own
   * texts created, which exists for anyone who has texted the number.
   */
  const deliverMedia = async (args: {
    chatGuid: string;
    path: string;
    caption?: string;
  }): Promise<SmsMediaDelivery> => {
    if (!isSmsChatGuid(args.chatGuid)) {
      return { ok: false, error: `not an sms chat guid: ${args.chatGuid}` };
    }
    const target = args.chatGuid.slice("sms:".length);
    const isGroup = target.startsWith("CH");
    let conversationSid: string;
    if (isGroup) {
      conversationSid = target;
    } else {
      const consent = store.checkConsent(target);
      if (!consent.allowed) {
        return {
          ok: false,
          error: `recipient opted out (${new Date(consent.sinceMs).toISOString()})`,
        };
      }
      const conv = store.conversationForDm(normalizeHandle(target));
      if (!conv) {
        return {
          ok: false,
          error:
            "no Twilio conversation with this person yet, so a file can't be sent; it opens the first time they text the number",
        };
      }
      conversationSid = conv;
    }

    const prepared = await prepareForMms(args.path);
    if (!prepared.ok) return { ok: false, error: prepared.reason };

    const api = opts.mediaApi ?? sdkConversationMediaApi(creds);
    let chatServiceSid: string;
    try {
      chatServiceSid = await api.chatServiceSid(conversationSid);
    } catch (err) {
      return { ok: false, error: `couldn't look up the conversation: ${String(err)}` };
    }
    const upload = await uploadMedia({
      creds,
      chatServiceSid,
      path: prepared.path,
      contentType: prepared.contentType,
    });
    if (!upload.ok) return { ok: false, error: upload.error };

    // A caption past the Conversations body limit goes as its own text first;
    // the file then carries no body rather than a truncated one.
    let caption = args.caption?.trim()
      ? sms.normalize_to_gsm7
        ? toGsm7(args.caption.trim())
        : args.caption.trim()
      : undefined;
    if (caption && caption.length > GROUP_MESSAGE_MAX_CHARS) {
      const text = await deliver({ chatGuid: args.chatGuid, isGroup, text: caption });
      if (text.sent === 0)
        return { ok: false, error: text.errors.join("; ") || "caption not sent" };
      caption = undefined;
    }

    let sid: string;
    try {
      sid = await api.postMedia({
        conversationSid,
        author: opts.ownNumber,
        mediaSid: upload.sid,
        body: caption,
      });
    } catch (err) {
      return { ok: false, error: `couldn't post the file: ${String(err)}` };
    }

    const noun = mediaNoun({ contentType: prepared.contentType });
    store.record({
      conversation: isGroup ? conversationSid : normalizeHandle(target),
      direction: "out",
      body: [`[${noun}]`, caption].filter(Boolean).join(" "),
      messageSid: sid,
    });
    const members = isGroup ? (store.groupInfo(conversationSid)?.participants.length ?? 1) : 1;
    // Estimate only, as for group texts: the per-recipient MMS records show
    // up in Twilio's message list later and the reconciler ledgers them.
    log.info("sms", "media sent", {
      conversationSid,
      sid,
      kind: noun,
      recipients: members,
      est: `$${estimateGroupOutboundUsd(members).toFixed(4)}`,
    });
    return { ok: true, sentPath: prepared.path, converted: prepared.converted };
  };

  return { store, deliver, deliverMedia };
}
