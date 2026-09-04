import { log } from "../util/log.ts";

/**
 * The Twilio REST send path.
 *
 * One function, typed errors, and no retry. Retrying a send that may already
 * have gone out is how a person receives the same message twice; when the
 * outcome is genuinely unknown the honest move is to say so and let the
 * caller decide, which is the same conclusion the iMessage bridge reached
 * after a timeout was mistaken for a rejection.
 *
 * Twilio returns HTTP 201 with `status: "queued"` for an accepted message.
 * **That is an acceptance, not a delivery.** Carrier filtering, an
 * unregistered campaign, or a landline all surface later as a status callback
 * or a fetched message with `status: "undelivered"` and an `error_code`.
 * `fetchStatus` exists so a caller can check where a message actually landed
 * rather than believing the write.
 */

export type SmsSendOk = {
  ok: true;
  sid: string;
  /** Twilio's own view at accept time — almost always "queued"/"accepted". */
  status: string;
  segments: number;
};

export type SmsSendErr = {
  ok: false;
  error: string;
  /** Twilio error code, when the API gave one. */
  code?: number;
  /** True when retrying could never help (bad number, opted out, unregistered). */
  permanent: boolean;
};

export type SmsSendResult = SmsSendOk | SmsSendErr;

/**
 * Twilio error codes that mean "do not try this again".
 *
 * 21610 is the one with teeth: the recipient replied STOP, and Twilio is
 * refusing on their behalf. It must be treated as consent state, not as a
 * transient failure — the caller records the opt-out so the harness stops
 * asking, rather than rediscovering it on every send.
 *
 * 30034 means the campaign is unregistered. Until the A2P campaign is
 * approved this is the expected outcome of every send, and it is billed.
 */
export const TWILIO_STOP_ERROR = 21610;
export const TWILIO_UNREGISTERED_ERROR = 30034;

const PERMANENT_CODES = new Set([
  21211, // invalid 'To' number
  21214, // 'To' not reachable / not mobile
  21606, // 'From' not a valid, SMS-capable number on the account
  21608, // trial account restriction
  21610, // recipient has opted out
  21612, // route not reachable
  30034, // unregistered A2P campaign
]);

export type TwilioCreds = {
  accountSid: string;
  /** Basic-auth user: an API key SID (SK…) or the account SID. */
  keySid: string;
  /** Basic-auth password: the API key secret or the auth token. */
  keySecret: string;
};

function authHeader(c: TwilioCreds): string {
  return `Basic ${Buffer.from(`${c.keySid}:${c.keySecret}`).toString("base64")}`;
}

/**
 * Send one SMS body.
 *
 * Exactly one of `messagingServiceSid` or `from` should be supplied. Prefer
 * the messaging service: it owns the sender pool and the A2P campaign
 * association, and sending from a bare number bypasses both — which is how a
 * message ends up unregistered even though the campaign is approved.
 */
export async function sendSms(params: {
  creds: TwilioCreds;
  to: string;
  body: string;
  messagingServiceSid?: string;
  from?: string;
  /** Twilio POSTs delivery transitions here. */
  statusCallback?: string;
  timeoutMs?: number;
}): Promise<SmsSendResult> {
  const { creds, to, body } = params;
  if (!body.trim()) return { ok: false, error: "empty body", permanent: true };
  if (!params.messagingServiceSid && !params.from) {
    return { ok: false, error: "no messagingServiceSid or from configured", permanent: true };
  }

  const form = new URLSearchParams();
  form.set("To", to);
  form.set("Body", body);
  if (params.messagingServiceSid) form.set("MessagingServiceSid", params.messagingServiceSid);
  else if (params.from) form.set("From", params.from);
  if (params.statusCallback) form.set("StatusCallback", params.statusCallback);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), params.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof json.code === "number" ? json.code : undefined;
      const message = typeof json.message === "string" ? json.message : `HTTP ${res.status}`;
      return {
        ok: false,
        error: message,
        code,
        permanent: code !== undefined && PERMANENT_CODES.has(code),
      };
    }
    return {
      ok: true,
      sid: String(json.sid ?? ""),
      status: String(json.status ?? "unknown"),
      segments: Number.parseInt(String(json.num_segments ?? "1"), 10) || 1,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      // A timeout is NOT a rejection. The message may still be delivered, so
      // the caller must not treat this as "safe to resend".
      error: aborted ? "twilio send timed out (delivery unknown)" : String(err),
      permanent: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where a message actually ended up, per Twilio.
 *
 * `status` is one of queued/sending/sent/delivered/undelivered/failed. Only
 * `delivered` means it reached a handset; `sent` means it reached the carrier
 * and is where filtering silently eats messages.
 */
export async function fetchStatus(
  creds: TwilioCreds,
  sid: string,
): Promise<{ status: string; errorCode: number | null } | null> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages/${sid}.json`;
  try {
    const res = await fetch(url, { headers: { Authorization: authHeader(creds) } });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    const code = json.error_code;
    return {
      status: String(json.status ?? "unknown"),
      errorCode: typeof code === "number" ? code : null,
    };
  } catch (err) {
    log.warn("sms", "status fetch failed", { sid, err: String(err) });
    return null;
  }
}

export function isPermanentCode(code: number | undefined): boolean {
  return code !== undefined && PERMANENT_CODES.has(code);
}

// ── Conversations API (group texting) ────────────────────────────────────
//
// Group MMS is a Conversations-only feature: classic Programmable Messaging
// cannot receive a group text at all, so inbound routing runs through
// Conversation autocreation and a group reply is a message POSTed into the
// Conversation rather than a Messages-API send. DMs deliberately stay on the
// Messages API — it has StatusCallback (delivery truth) and costs no
// Conversations MAU.

export type ConversationParticipant = {
  sid: string;
  /** E.164 for an SMS participant; null for chat-identity participants. */
  address: string | null;
  /** The Twilio number this participant is bound through, when SMS. */
  proxyAddress: string | null;
};

/** Post one message into a Conversation — delivered to every participant. */
export async function sendConversationMessage(params: {
  creds: TwilioCreds;
  conversationSid: string;
  body: string;
  /** The sending identity. For group texting from a projected address this is
   *  our own E.164 number. */
  author: string;
  timeoutMs?: number;
}): Promise<SmsSendResult> {
  const { creds, conversationSid, body } = params;
  if (!body.trim()) return { ok: false, error: "empty body", permanent: true };
  const form = new URLSearchParams();
  form.set("Body", body);
  form.set("Author", params.author);
  const url = `https://conversations.twilio.com/v1/Conversations/${conversationSid}/Messages`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), params.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof json.code === "number" ? json.code : undefined;
      return {
        ok: false,
        error: typeof json.message === "string" ? json.message : `HTTP ${res.status}`,
        code,
        permanent: code !== undefined && PERMANENT_CODES.has(code),
      };
    }
    return {
      ok: true,
      sid: String(json.sid ?? ""),
      status: "queued",
      // Conversations does not report segments; count what we sent.
      segments: 1,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "conversation send timed out (delivery unknown)" : String(err),
      permanent: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Who is in a Conversation, per Twilio. Used once on first sight of a
 *  ConversationSid to classify it (DM vs group) and snapshot the roster. */
export async function fetchConversationParticipants(
  creds: TwilioCreds,
  conversationSid: string,
): Promise<ConversationParticipant[] | null> {
  const url = `https://conversations.twilio.com/v1/Conversations/${conversationSid}/Participants?PageSize=50`;
  try {
    const res = await fetch(url, { headers: { Authorization: authHeader(creds) } });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      participants?: {
        sid: string;
        messaging_binding?: { address?: string; proxy_address?: string } | null;
      }[];
    };
    return (json.participants ?? []).map((p) => ({
      sid: p.sid,
      address: p.messaging_binding?.address ?? null,
      proxyAddress: p.messaging_binding?.proxy_address ?? null,
    }));
  } catch (err) {
    log.warn("sms", "participant fetch failed", { conversationSid, err: String(err) });
    return null;
  }
}
