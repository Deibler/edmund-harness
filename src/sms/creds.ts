import { log } from "../util/log.ts";
import type { TwilioCreds } from "./client.ts";

/**
 * Resolve Twilio credentials from the environment, tolerating the shapes
 * they actually arrive in.
 *
 * The clean shape:
 *   TWILIO_ACCOUNT_SID     AC…  (the account)
 *   TWILIO_API_KEY_SID     SK…  (REST auth user)
 *   TWILIO_API_KEY_SECRET       (REST auth password)
 *   TWILIO_AUTH_TOKEN           (webhook signature validation ONLY)
 *
 * The shape that actually happens: an API key SID pasted into
 * TWILIO_ACCOUNT_SID with its secret in TWILIO_AUTH_TOKEN — because the
 * console hands you a key and the .env has two slots. That pair authenticates
 * REST fine, so it is accepted, with the account SID discovered via one
 * Accounts list call. What it CANNOT do is validate webhooks: signatures are
 * HMAC'd with the auth token and nothing else, so inbound stays dead until a
 * real TWILIO_AUTH_TOKEN is present — and that is said loudly at boot rather
 * than discovered as silently rejected messages.
 */
export type ResolvedTwilio = {
  creds: TwilioCreds;
  /** Auth token for webhook signatures; null = inbound cannot validate. */
  webhookAuthToken: string | null;
};

export async function resolveTwilioCreds(env = process.env): Promise<ResolvedTwilio | null> {
  const sid = env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const keySid = env.TWILIO_API_KEY_SID?.trim() ?? "";
  const keySecret = env.TWILIO_API_KEY_SECRET?.trim() ?? "";

  // Clean shape first.
  if (sid.startsWith("AC")) {
    if (keySid.startsWith("SK") && keySecret) {
      return {
        creds: { accountSid: sid, keySid, keySecret },
        webhookAuthToken: authToken || null,
      };
    }
    if (authToken) {
      return {
        creds: { accountSid: sid, keySid: sid, keySecret: authToken },
        webhookAuthToken: authToken,
      };
    }
    log.warn("sms", "TWILIO_ACCOUNT_SID set but no API key or auth token — sms disabled");
    return null;
  }

  // The misnamed shape: SK… in the account slot, secret in the token slot.
  if (sid.startsWith("SK") && authToken) {
    const account = await discoverAccountSid(sid, authToken);
    if (!account) {
      log.warn("sms", "could not resolve account from API key — sms disabled");
      return null;
    }
    log.warn(
      "sms",
      "TWILIO_ACCOUNT_SID holds an API key SID; resolved account via API. " +
        "Webhook signature validation needs the real TWILIO_AUTH_TOKEN — inbound will be rejected until it is set.",
      { account },
    );
    return {
      creds: { accountSid: account, keySid: sid, keySecret: authToken },
      webhookAuthToken: null,
    };
  }

  return null;
}

async function discoverAccountSid(keySid: string, keySecret: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.twilio.com/2010-04-01/Accounts.json?PageSize=5", {
      headers: {
        Authorization: `Basic ${Buffer.from(`${keySid}:${keySecret}`).toString("base64")}`,
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { accounts?: { sid: string; status: string }[] };
    const active = (json.accounts ?? []).find((a) => a.status === "active");
    return active?.sid ?? null;
  } catch {
    return null;
  }
}
