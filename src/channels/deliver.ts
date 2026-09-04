import type { Config } from "../config/config.ts";
import { chunkForIMessage } from "../imessage/chunk.ts";
import { ChatDb } from "../imessage/db.ts";
import { hasMapsLink, looksLikeStreetAddress } from "../imessage/maps-link.ts";
import { type SendArgs, sendMessage } from "../imessage/send.ts";
import { ContactBook } from "../sessions/contacts.ts";
import type { EchoCache } from "../sessions/echo-cache.ts";
import { dmKeyFor } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import { log } from "../util/log.ts";
import { markdownToPlaintext, sanitizeOutbound } from "./sanitize-outbound.ts";

/**
 * Mirror channel deliverer — registered by main.ts when [mirror] is enabled.
 * The mirror is a delivery medium like iMessage: any reply
 * addressed to a `mirror:*` chat id (inbound voice turns, cron briefs,
 * recovery fires) routes here instead of the iMessage send paths.
 */
/** Result shape the mirror channel returns. Declared here rather than imported
 *  so core compiles without the mirror package installed. Mirrors
 *  `MirrorDelivery` in integrations/mirror/src/bridge.ts. */
type MirrorDelivery = { delivered: boolean; suppressed?: boolean; error?: string };
type MirrorDeliverer = (text: string, turnId?: string) => Promise<MirrorDelivery>;
let mirrorDeliverer: MirrorDeliverer | null = null;
export function setMirrorDeliverer(fn: MirrorDeliverer | null): void {
  mirrorDeliverer = fn;
}

/** Result shape the SMS channel returns. Declared here for the same reason as
 *  MirrorDelivery: core compiles without the SMS module loaded. Mirrors
 *  `SmsChannelDelivery` in src/sms/channel.ts. */
type SmsDelivery = { sent: number; sentChunks: string[]; errors: string[]; silenced: boolean };
type SmsDeliverer = (args: {
  /** `sms:`-prefixed conversation guid (`sms:+1717…` or `sms:CH…`). */
  chatGuid: string;
  isGroup: boolean;
  text: string;
}) => Promise<SmsDelivery>;
let smsDeliverer: SmsDeliverer | null = null;
export function setSmsDeliverer(fn: SmsDeliverer | null): void {
  smsDeliverer = fn;
}

export type DeliverArgs = {
  to: string;
  isGroup: boolean;
  text: string;
  /** Stable chat.guid — lets the reply-to/effect bridge address the chat directly. */
  chatGuid?: string;
  /** Message guid to reply-to (native inline reply threading). */
  replyTo?: string;
  /** Expressive-send effect id (impact, confetti, lasers, …). */
  effect?: string;
  /** Mirror-only model turn identity for generation-fenced delivery. */
  turnId?: string;
};

/**
 * The chat.db GUID for a DM handle's live conversation, if one exists.
 *
 * Turn deliveries pass an explicit chatGuid; the paths that only know the
 * session — cron fires, recovery replays, boot flushes — used to send by bare
 * handle and let IMCore pick the chat object. IMCore's pick is only as good
 * as its registry, and a poisoned registry entry (the note-to-self damage a
 * forced-account send leaves behind in imagent) swallowed a reply whole while
 * chat.db knew the right conversation all along. Resolving here makes every
 * reply GUID-addressed the way turn deliveries already are.
 *
 * No conversation yet resolves to nothing, and the send goes by handle —
 * which is how a first message legitimately starts a chat. A resolution
 * *error* also sends by handle, but says so: delivering the reply matters
 * more than perfecting its address, and the warning keeps the failure loud.
 */
function resolveDmChatGuid(handle: string, config: Config): string | undefined {
  let chatDb: ChatDb | undefined;
  try {
    chatDb = new ChatDb(config.paths.chat_db);
    const guids = chatGuidsForSession(dmKeyFor(handle), chatDb, new ContactBook(config.contacts));
    return guids[0];
  } catch (err) {
    log.warn("deliver", "dm chat-guid resolution failed, sending by handle", {
      handle,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  } finally {
    chatDb?.close();
  }
}

/**
 * Take a raw Claude reply and deliver it cleanly:
 *  1. Sanitize (strip scaffolding).
 *  2. Flatten Markdown (iMessage is plaintext).
 *  3. Chunk to fit iMessage limits without breaking fences.
 *  4. Send chunks sequentially with a short delay (avoids Messages.app
 *     dropping back-to-back sends).
 *  5. Record each chunk into the echo cache so we don't loop.
 *
 * Only the *first* chunk carries the reply-to threading marker — the rest
 * follow in order underneath, which reads naturally in iMessage.
 *
 * `silenced` distinguishes "the silence-intent filter or scaffolding strip
 * collapsed the reply to empty" from a real delivery failure. Callers
 * should treat silenced as success (no error logging) — the model
 * effectively chose not to reply, which is valid for recovery cron fires
 * and similar low-stakes wake-ups.
 */
export async function deliverReply(
  args: DeliverArgs,
  config: Config,
  echoes: EchoCache,
): Promise<{ sent: number; sentChunks: string[]; errors: string[]; silenced: boolean }> {
  const cleaned = markdownToPlaintext(sanitizeOutbound(args.text));
  if (!cleaned) return { sent: 0, sentChunks: [], errors: [], silenced: true };

  // Telemetry only. Addresses are supposed to go out as Maps cards via
  // send_location, and that rule lives in the prompt — which makes it a hope
  // until something counts it. This logs when a street address ships as prose
  // with no card alongside it, so compliance is answerable from the log rather
  // than from impressions. It deliberately does not rewrite or block: a false
  // positive here would cost a real message, and the card is a nicety.
  if (looksLikeStreetAddress(cleaned) && !hasMapsLink(cleaned)) {
    log.info("deliver", "address sent as text — send_location would render a tappable card", {
      to: args.to,
    });
  }

  // Mirror channel: rendered on the glass and spoken only inside a user-opened
  // voice volley. It does not use iMessage chunking or echo suppression.
  if (args.to.startsWith("mirror:")) {
    if (!mirrorDeliverer) {
      return {
        sent: 0,
        sentChunks: [],
        errors: ["mirror deliverer not registered"],
        silenced: false,
      };
    }
    try {
      const delivery = await mirrorDeliverer(cleaned, args.turnId);
      if (delivery.delivered) {
        return { sent: 1, sentChunks: [cleaned], errors: [], silenced: false };
      }
      if (delivery.suppressed) {
        return { sent: 0, sentChunks: [], errors: [], silenced: true };
      }
      return {
        sent: 0,
        sentChunks: [],
        errors: [delivery.error ?? "mirror did not accept the reply"],
        silenced: false,
      };
    } catch (err) {
      return { sent: 0, sentChunks: [], errors: [(err as Error).message], silenced: false };
    }
  }

  // SMS channel (Twilio). Discriminated on the `sms:` chat-guid prefix, which
  // every path carries: turns pass the inbound's chatGuid, and cron/recovery
  // read the same value back from the session row. The check runs BEFORE the
  // chat.db resolution below — a person who texts Edmund's Twilio number AND
  // has an iMessage thread exists in both worlds, and falling through would
  // resolve their bare phone number to the iMessage chat: a reply to a green
  // conversation delivered as a blue one, from an address they may not know.
  const smsGuid = args.chatGuid?.startsWith("sms:")
    ? args.chatGuid
    : args.to.startsWith("sms:")
      ? args.to
      : null;
  if (smsGuid) {
    if (!smsDeliverer) {
      return { sent: 0, sentChunks: [], errors: ["sms deliverer not registered"], silenced: false };
    }
    try {
      const delivery = await smsDeliverer({
        chatGuid: smsGuid,
        isGroup: args.isGroup,
        text: cleaned,
      });
      for (const chunk of delivery.sentChunks) echoes.recordSent(chunk);
      return delivery;
    } catch (err) {
      return { sent: 0, sentChunks: [], errors: [(err as Error).message], silenced: false };
    }
  }

  // GUID-address every DM whose conversation already exists, so no send is
  // left to the registry's discretion.
  const chatGuid = args.chatGuid ?? (args.isGroup ? undefined : resolveDmChatGuid(args.to, config));

  const chunks = chunkForIMessage(cleaned, config.behavior.chunk_chars);
  const errors: string[] = [];
  // Exact chunk texts that made it onto the wire — callers record these as
  // sent-attributions so per-orchestrator history filtering can match the
  // chat.db is_from_me rows back to whoever sent them.
  const sentChunks: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const res = await sendMessage({
      to: args.to,
      isGroup: args.isGroup,
      text: chunk,
      // No service is ever named: a reply goes however the conversation
      // already sends. Naming one routed the message over an account instead
      // of into the chat (sendMessage:onAccount:), which is the act that
      // poisons imagent's registry object for the chat — the source of every
      // "routes to self" incident. The field no longer exists to pass.
      chatGuid,
      // Reply-to and the effect ride only on the first chunk; the rest follow
      // underneath as plain bubbles, which reads naturally in iMessage.
      replyTo: i === 0 && config.behavior.reply_threading ? args.replyTo : undefined,
      effect: i === 0 ? args.effect : undefined,
    });
    if (res.ok) {
      echoes.recordSent(chunk);
      sentChunks.push(chunk);
    } else {
      errors.push(res.error);
      break;
    }
    if (i < chunks.length - 1) await delay(400);
  }
  return { sent: sentChunks.length, sentChunks, errors, silenced: false };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
