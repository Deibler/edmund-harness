import type { SessionPipeline } from "../channels/pipeline.ts";
import type { Config } from "../config/config.ts";
import type { InboundMessage } from "../imessage/types.ts";
import { normalizeHandle } from "../sessions/key.ts";
import { log } from "../util/log.ts";
import { type TwilioCreds, fetchConversationParticipants } from "./client.ts";
import { estimateInboundUsd } from "./costs.ts";
import { classifyKeyword, keywordReply } from "./inbound.ts";
import { type SmsChannelDelivery, createSmsSender } from "./sender.ts";
import { conversationIdFromKey, smsChatGuidFor, smsGroupKeyFor, smsKeyFor } from "./session.ts";
import type { SmsStore } from "./store.ts";

/**
 * The SMS channel — everything between the Twilio wire and the harness's
 * existing turn machinery.
 *
 * The shape copies the mirror: inbound webhooks become synthetic
 * `InboundMessage`s enqueued on the shared pipeline, and outbound goes
 * through a deliverer registered with `setSmsDeliverer` so
 * `channels/deliver.ts` needs no import of anything Twilio.
 *
 * ## Routing truths this module encodes
 *
 *  - **All inbound arrives via Conversations webhooks** (autocreation on the
 *    messaging service), because classic Programmable Messaging cannot
 *    receive a group MMS at all. A DM is simply a two-party Conversation.
 *  - **Outbound DMs use the Messages API** (status callbacks, no MAU cost);
 *    **outbound group replies POST into the Conversation**, which is the only
 *    way to address the room.
 *  - A Conversation is classified exactly once (participant fetch on first
 *    sight), then remembered. Sessions are keyed `sms:dm:<handle>` for DMs —
 *    person-keyed, so a deleted-and-recreated Conversation does not fork
 *    someone's history — and `sms:group:<CH sid>` for groups.
 */

export type { SmsChannelDelivery };

export type SmsRuntime = {
  store: SmsStore;
  /** Registered with setSmsDeliverer. */
  deliverer: (args: {
    chatGuid: string;
    isGroup: boolean;
    text: string;
  }) => Promise<SmsChannelDelivery>;
  /** Handle a validated onMessageAdded webhook. */
  onMessageAdded: (params: Record<string, string>) => Promise<void>;
  /** deps.sms providers for history + group roster. */
  depsProviders: {
    history: (conversationId: string, limit: number) => ReturnType<SmsStore["recentLines"]>;
    groupInfo: (
      conversationSid: string,
    ) => { friendlyName: string | null; participants: string[] } | null;
  };
};

export function createSmsChannel(opts: {
  config: Config;
  creds: TwilioCreds;
  pipeline: SessionPipeline;
  dataDir: string;
  /** Our own sending number, E.164. Used to recognize our echoes and to
   *  author group replies. */
  ownNumber: string;
  /** Does the operator know this number? (ContactBook + AddressBook.) The
   *  admission gate when [sms].allowlist is empty and unknown senders are
   *  not explicitly allowed. */
  isKnownSender?: (handle: string) => boolean;
  statusCallbackUrl?: string;
}): SmsRuntime {
  const { config, creds, pipeline } = opts;
  // One sender, two processes: the daemon registers `deliver` as the
  // channel deliverer, and the MCP server builds its own from the same
  // factory. See src/sms/sender.ts.
  const { store, deliver: deliverer } = createSmsSender({
    config,
    creds,
    ownNumber: opts.ownNumber,
    statusCallbackUrl: opts.statusCallbackUrl,
    dataDir: opts.dataDir,
  });
  const own = normalizeHandle(opts.ownNumber);
  const sms = config.sms;
  let syntheticSeq = 0;

  const inboundFor = (params: {
    conversationId: string;
    isGroup: boolean;
    fromHandle: string;
    text: string;
    messageSid: string;
  }): InboundMessage => {
    const now = Date.now();
    return {
      rowId: now * 1_000 + (syntheticSeq++ % 1_000),
      msgGuid: `sms-${params.messageSid}`,
      chatIdentifier: params.conversationId,
      chatGuid: smsChatGuidFor(params.conversationId),
      isGroup: params.isGroup,
      fromHandle: params.fromHandle,
      fromMe: false,
      text: params.text,
      timestampMs: now,
      // MMS media is not fetched yet; the transcript records that something
      // arrived so the model can say so instead of ignoring it.
      attachments: [],
      attachmentTranscripts: {},
      service: "SMS",
      replyToGuid: null,
    };
  };

  /**
   * Classify a Conversation on first sight: fetch participants once, count
   * the human addresses (anything that is not our own number), remember the
   * verdict. Failure to classify drops the message with a loud log rather
   * than guessing — a group turn misfiled as a DM would reply to one person
   * with words meant for the room.
   */
  const classify = async (
    conversationSid: string,
  ): Promise<{ kind: "dm" | "group"; peerHandle: string | null } | null> => {
    const known = store.conversationKind(conversationSid);
    if (known) return known;
    const participants = await fetchConversationParticipants(creds, conversationSid);
    if (!participants) return null;
    const humans = [
      ...new Set(
        participants
          .map((p) => (p.address ? normalizeHandle(p.address) : null))
          .filter((a): a is string => a !== null && a !== own),
      ),
    ];
    if (humans.length === 0) return null;
    if (humans.length === 1) {
      store.registerConversation(conversationSid, "dm", humans[0]);
      return { kind: "dm", peerHandle: humans[0]! };
    }
    store.registerConversation(conversationSid, "group");
    store.upsertGroup({ conversationSid, friendlyName: null, participants: humans });
    return { kind: "group", peerHandle: null };
  };

  const onMessageAdded = async (params: Record<string, string>): Promise<void> => {
    const conversationSid = params.ConversationSid ?? "";
    const messageSid = params.MessageSid ?? "";
    const author = normalizeHandle(params.Author ?? "");
    const body = (params.Body ?? "").trim();
    if (!conversationSid || !messageSid) return;

    // Our own REST-posted group replies come back through this webhook too.
    // Author is the reliable discriminator — dropping by body hash would also
    // swallow a person genuinely typing the same words.
    if (author === own) return;

    // Claim before any work: Twilio retries webhooks that did not 2xx fast,
    // and the claim must happen exactly once even under concurrent retries.
    // (The window between claim and enqueue is in-memory work; a crash there
    // loses one message rather than double-replying, which is the right side
    // of the trade for a channel where a duplicate reply reads as a glitch.)
    if (!store.claimInbound(messageSid)) return;

    const cls = await classify(conversationSid);
    if (!cls) {
      log.warn("sms", "unclassifiable conversation — message dropped", {
        conversationSid,
        messageSid,
      });
      return;
    }
    const isGroup = cls.kind === "group";
    const conversationId = isGroup ? conversationSid : (cls.peerHandle ?? author);

    // Carrier keywords are DM-only by design. In a group, a lone "Stop" is
    // far more often aimed at the conversation than at the carrier — a hard
    // opt-out recorded from group banter would silently kill DMs to that
    // person. Twilio's per-number-pair opt-out still applies underneath.
    if (!isGroup) {
      const kw = classifyKeyword(body);
      if (kw === "stop") {
        store.setOptedOut(author, body.toUpperCase());
        store.record({
          conversation: conversationId,
          direction: "in",
          fromHandle: author,
          body,
          messageSid,
        });
        log.info("sms", "opt-out recorded", { handle: author });
        const reply = keywordReply("stop", {
          carrierHandlesKeywords: sms.carrier_handles_keywords,
          helpText: sms.help_text,
        });
        if (reply)
          await deliverer({ chatGuid: smsChatGuidFor(author), isGroup: false, text: reply });
        return; // never a model turn
      }
      if (kw === "start") {
        store.setOptedIn(author, body.toUpperCase());
        store.record({
          conversation: conversationId,
          direction: "in",
          fromHandle: author,
          body,
          messageSid,
        });
        log.info("sms", "opt-in recorded", { handle: author });
        const reply = keywordReply("start", {
          carrierHandlesKeywords: sms.carrier_handles_keywords,
          helpText: sms.help_text,
        });
        if (reply)
          await deliverer({ chatGuid: smsChatGuidFor(author), isGroup: false, text: reply });
        return;
      }
      if (kw === "help") {
        store.record({
          conversation: conversationId,
          direction: "in",
          fromHandle: author,
          body,
          messageSid,
        });
        const reply = keywordReply("help", {
          carrierHandlesKeywords: sms.carrier_handles_keywords,
          helpText: sms.help_text,
        });
        if (reply)
          await deliverer({ chatGuid: smsChatGuidFor(author), isGroup: false, text: reply });
        return;
      }
    }

    // Admission. SMS sessions do not pass through the iMessage gate
    // (shouldAccept) or the guest-tier machinery — this enqueue IS the door,
    // so the check lives here, on the only path in. Order: explicit
    // allowlist beats everything; otherwise known contacts are admitted;
    // strangers only if allow_unknown_senders was deliberately switched on.
    const admitted = (handle: string): boolean => {
      if (sms.allowlist.length > 0) return sms.allowlist.map(normalizeHandle).includes(handle);
      if (opts.isKnownSender?.(handle)) return true;
      return sms.allow_unknown_senders;
    };
    if (!isGroup && !admitted(author)) {
      log.info("sms", "sender not admitted — ignored", { handle: author });
      return;
    }
    // A group is admitted through its people: anyone can add a number to a
    // group MMS, so membership alone proves nothing. At least one participant
    // (or the author) must themselves be admitted or the room is ignored.
    if (isGroup) {
      const roster = store.groupInfo(conversationSid)?.participants ?? [];
      if (![author, ...roster].some(admitted)) {
        log.info("sms", "group with no admitted participant — ignored", { conversationSid });
        return;
      }
    }

    const mediaNote =
      Number.parseInt(params.NumMedia ?? "0", 10) > 0
        ? body
          ? `${body}\n[attachment received — media over SMS is not supported yet]`
          : "[attachment received — media over SMS is not supported yet]"
        : body;
    if (!mediaNote) return;

    store.record({
      conversation: conversationId,
      direction: "in",
      fromHandle: author,
      body: mediaNote,
      messageSid,
    });

    log.info("sms", "inbound", {
      from: author,
      group: isGroup,
      est: `$${estimateInboundUsd(isGroup ? "mms" : "sms").toFixed(4)}`,
    });

    const key = isGroup ? smsGroupKeyFor(conversationSid) : smsKeyFor(cls.peerHandle ?? author);
    pipeline.enqueue(
      key,
      inboundFor({ conversationId, isGroup, fromHandle: author, text: mediaNote, messageSid }),
    );
  };

  return {
    store,
    deliverer,
    onMessageAdded,
    depsProviders: {
      history: (conversationId, limit) => store.recentLines(conversationId, limit),
      groupInfo: (conversationSid) => {
        const g = store.groupInfo(conversationSid);
        return g ? { friendlyName: g.friendlyName, participants: g.participants } : null;
      },
    },
  };
}

/** Re-export for wiring code that only has the session key. */
export { conversationIdFromKey };
